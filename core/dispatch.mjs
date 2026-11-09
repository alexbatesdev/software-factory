// Auto-dispatch (Alex, 2026-10-28): which ready or queued records start themselves this tick, and why the rest wait.
// Pure: the server applies the plan through ordinary events and logs each one on its record.
import { routeOf } from './notifier.mjs';
import { BUILDING, REVIEWING, TERMINAL, LIVE_ASSIGNMENT, parked, trackOf, queueOrder, needsPrApproval } from './work.mjs';

const live = w => (w.assignments || []).some(a => a.kind !== 'review' && LIVE_ASSIGNMENT.includes(a.status));
const pendingDispatch = w => (w.requests || []).some(r => r.type === 'dispatch' && !r.ack);
const takenUp = w => (w.requests || []).some(r => r.type === 'dispatch' && ['received', 'done'].includes(r.ack?.outcome));
// A stream is busy while its worker has a job: building or fixing, a live work assignment, or a dispatch not yet acked.
const active = w => BUILDING.includes(w.phase) || live(w) || (w.phase === 'queued' && pendingDispatch(w));

/** A stream with `repos` {name: checkout} (a host stream, TB-159) works only those repos; the sbx streams work everything else. */
export function canTake(w, label, supervisors) {
  // A host stream names its repos, and branches inside other repos (Mutation work, 11-09) that need the host.
  const has = s => (!!s?.repos && Object.hasOwn(s.repos, w.repo ?? '')) || (!!s?.branches && new RegExp(s.branches).test(w.links?.branch || ''));
  return supervisors[label]?.repos || supervisors[label]?.branches ? has(supervisors[label]) : !Object.values(supervisors).some(has);
}

// Work blocked on a person holds no stream (Alex: keep workers on unblocked work while a part waits), unless an agent is on it.
const onAlex = w => w.openQuestions > 0 && !(w.assignments || []).some(a => ['started', 'blocked'].includes(a.status));
// Work parked on a named blocker holds no stream either; once the blocker clears it resumes ahead of new work.
const parkedOnly = w => (w.assignments || []).some(parked) && !(w.assignments || []).some(a => ['queued', 'started'].includes(a.status));
// A Sentry scout never holds a stream either: real work always wins (Alex, 11-09); the scout just finishes.
const holdsNone = w => w.kind === 'scout' || onAlex(w) || parkedOnly(w);
// An internal review runs on the stream's own worker (Alex, 10-28), so it holds the stream; a reviewer pane's doesn't.
const running = workers => w => BUILDING.includes(w.phase) || (w.assignments || []).some(a => (a.kind !== 'review' || workers.has(a.owner)) && ['started', 'blocked'].includes(a.status));
const workersOf = cfg => new Set(Object.values(cfg.supervisors || {}).map(s => s?.worker).filter(Boolean));

/** Busy streams and what holds each: running work first, then queued assignments and unacked dispatches, then draining. */
export function busyStreams(works, cfg) {
  const labels = Object.keys(cfg.supervisors || {}), busy = new Map();
  for (const pass of [running(workersOf(cfg)), active]) for (const w of works) { const to = routeOf(w, labels); if (to && !holdsNone(w) && pass(w) && !busy.has(to)) busy.set(to, w.id); }
  // A draining stream (its worker is due a recycle) takes nothing new, priority work included.
  for (const [to, why] of cfg.drain || []) busy.set(to, why);
  return busy;
}

const worked = w => (w.assignments || []).some(a => a.kind !== 'review' && ['started', 'blocked', 'done'].includes(a.status));
const STREAM_LOAD = ['queued', ...BUILDING, ...REVIEWING];

/**
 * The stream that must take this record, if any (decision 8): one Alex pinned, the stream that already worked on it,
 * or the stream of a live record it is stacked on, parented to or the same work as. Otherwise any stream may.
 */
export function boundStream(w, byId, labels) {
  if (w.streamPin && routeOf(w, labels)) return { to: w.stream, why: `pinned by ${w.streamPin.by}` };
  if (worked(w) && routeOf(w, labels)) return { to: w.stream, why: 'its stream already worked on it' };
  const near = [w.parent, ...(w.related || []).filter(r => r.kind === 'same-work').map(r => r.to), ...(w.deps || [])]
    .map(id => byId.get(id)).filter(o => o && !TERMINAL.includes(o.phase) && worked(o) && routeOf(o, labels));
  return near.length ? { to: near[0].stream, why: `${near[0].id} shares its branch` } : null;
}

/** Load per stream: its records holding or waiting for its worker. */
export function streamLoad(works, labels) {
  const load = Object.fromEntries(labels.map(l => [l, 0]));
  for (const w of works) { const to = routeOf(w, labels); if (to && w.kind !== 'scout' && STREAM_LOAD.includes(w.phase)) load[to]++; }
  return load;
}

/**
 * @param works server work views (openQuestions, openDeps, intakeHold included)
 * @param cfg {supervisors: {label: {...}}, exclude: [W-n], drain: Map(stream → reason) for streams taking no new work}; config order breaks load ties
 * @param fleet {terminals: [pane labels running in Terminals]}
 * @returns [{id, action: 'queue'|'request'|null, owner?, reason}] for every ready/queued record not already with its supervisor
 */
export function autoDispatchPlan(works, cfg, { terminals = [] } = {}) {
  const labels = Object.keys(cfg.supervisors || {});
  const busy = busyStreams(works, cfg), workers = workersOf(cfg), isRunning = running(workers);
  // Priority work (priority 1) cuts in behind whatever a stream is running, ahead of anything queued there.
  const runningOn = new Map();
  for (const w of works) { const to = routeOf(w, labels); if (to && !holdsNone(w) && isRunning(w) && !runningOn.has(to)) runningOn.set(to, w.id); }
  for (const [to, why] of cfg.drain || []) runningOn.set(to, why);
  const out = [], byId = new Map(works.map(w => [w.id, w])), load = streamLoad(works, labels);
  for (const w of works.filter(parkedOnly)) {
    const p = (w.parked || []).find(x => x.cleared), to = routeOf(w, labels);
    if (!p || !to) continue;
    if (busy.has(to)) { out.push({ id: w.id, action: null, reason: `${p.waitingOn} cleared; ${to} is busy with ${busy.get(to)}, resumes next` }); continue; }
    busy.set(to, w.id); runningOn.set(to, w.id);
    out.push({ id: w.id, action: 'resume', to, assignmentId: p.assignmentId, version: p.version, reason: `${p.waitingOn} cleared, ${to} is free` });
  }
  const order = works.filter(w => ['ready', 'queued'].includes(w.phase) && !(w.phase === 'queued' && (pendingDispatch(w) || takenUp(w) || live(w))))
    .sort(queueOrder);
  for (const w of order) {
    const wait = reason => out.push({ id: w.id, action: null, reason });
    const holds = w.priority === 1 ? runningOn : busy;
    const track = trackOf(w, cfg);
    if (track === 'excluded') { wait('Excluded in config.autoDispatch.exclude'); continue; }
    if (track === 'trusted-review') { wait('a trusted review, not stream work'); continue; }
    if (w.kind === 'factory') { wait('a factory record: the board developer builds it'); continue; }
    if (w.intakeHold) { wait(`intake hold by ${w.intakeHold.by}`); continue; }
    if (w.owner && terminals.includes(w.owner)) { wait(`owner ${w.owner} runs in Terminals`); continue; }
    if (w.waitingOn) { wait(`waiting on ${w.waitingOn.who}: ${w.waitingOn.what}`); continue; }
    if (w.owner && !labels.includes(w.owner) && !workers.has(w.owner)) { wait(`owned by ${w.owner}, not a stream`); continue; }
    if (w.openQuestions > 0) { wait(`${w.openQuestions} open question(s)`); continue; }
    if (w.openDeps?.length) { wait(`waiting on ${w.openDeps.join(', ')}`); continue; }
    if (w.externalDeps?.length) { wait(`external dependency: ${w.externalDeps.map(d => d.text || d.ref).join('; ')}`); continue; }
    if (needsPrApproval(w, cfg.prApproval?.trusted)) { wait("needs Alex's go to open a new PR (dashboard: New PRs)"); continue; }
    const bound = boundStream(w, byId, labels);
    // A stream that declined this record isn't sent it again unless someone pins it there (W-217).
    const declined = new Set((w.requests || []).filter(r => r.type === 'dispatch' && r.ack?.outcome === 'declined').map(r => r.ack.by));
    if (bound && !canTake(w, bound.to, cfg.supervisors)) { wait(`${bound.to} can't work in ${w.repo || 'built-rails'}; re-route it`); continue; }
    if (bound && declined.has(bound.to) && !w.streamPin) { wait(`${bound.to} declined it; re-route or pin it`); continue; }
    if (bound && holds.has(bound.to)) { wait(`${bound.to} is busy with ${holds.get(bound.to)}; waits its turn (${bound.why})`); continue; }
    // ponytail: ties go to config order, not the stream idle longest; add last-dispatch times if one stream keeps winning ties.
    const here = routeOf(w, labels), mine = STREAM_LOAD.includes(w.phase) ? here : null;
    const cost = l => load[l] // this record's own slot doesn't count against its stream
      - (l === mine ? 1 : 0);
    const to = bound?.to || labels.filter(l => !holds.has(l) && !declined.has(l) && canTake(w, l, cfg.supervisors)).sort((a, b) => cost(a) - cost(b))[0];
    if (!to) { wait(`every stream is busy (${[...holds].map(([l, id]) => `${l} with ${id}`).join(', ')}); waits its turn`); continue; }
    busy.set(to, w.id); runningOn.set(to, w.id);
    const spread = labels.map(l => `${l}: ${cost(l)}`).join(', ');
    if (mine) load[mine]--;
    load[to]++;
    const owner = to !== w.stream ? to : undefined;
    out.push({ id: w.id, action: w.phase === 'ready' ? 'queue' : 'request', owner, to,
      reason: `${w.priority === 1 ? 'priority: ' : ''}${w.phase}, no open questions or dependencies, ${to} is free${bound ? ` (${bound.why})` : `, least loaded (${spread})`}` });
  }
  return out;
}
