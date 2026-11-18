// Auto-dispatch (Alex, 2026-10-28): which ready or queued records start themselves this tick, and why the rest wait.
// Pure: the server applies the plan through ordinary events and logs each one on its record.
import { routeOf, currentRequest } from './notifier.mjs';
import { BUILDING, REVIEWING, TERMINAL, LIVE_ASSIGNMENT, parked, trackOf, queueOrder, needsPrApproval, DEFAULT_REPO } from './work.mjs';

const live = w => (w.assignments || []).some(a => a.kind !== 'review' && LIVE_ASSIGNMENT.includes(a.status));
const pendingDispatch = w => (w.requests || []).some(r => r.type === 'dispatch' && !r.ack);
const takenUp = w => (w.requests || []).some(r => r.type === 'dispatch' && ['received', 'done'].includes(r.ack?.outcome));
const runs = w => (w.assignments || []).some(a => a.kind !== 'review' && ['started', 'blocked'].includes(a.status));
// Queued by assign alone (local-head, the factory lead): nobody has been told yet, so it still needs its dispatch request (W-482).
const unrequested = w => w.phase === 'queued' && !pendingDispatch(w) && !takenUp(w) && !runs(w);
// One factory queue (Alex 11-16, W-505): a fixes or review request no worker has started and no stream has been told of
// waits for the next free stream, not for the stream that built the record.
const liveJob = w => (w.assignments || []).some(a => ['started', 'blocked'].includes(a.status) && !parked(a));
// A queued job beside an unacked request (W-533) is still waiting for a stream: nobody has taken the round up yet.
export const waitingRequest = (w, told = new Set()) => !liveJob(w)
  && (w.requests || []).find(r => ['fixes', 'review'].includes(r.type) && currentRequest(w, r) && !told.has(`${w.id}/${r.id}`)) || null;
// A stream is busy while its worker has a job: building or fixing, a live work assignment, or a dispatch not yet started
// (unacked, or acked before the supervisor records it started: W-554).
const active = told => w => (BUILDING.includes(w.phase) || live(w) || (w.phase === 'queued' && (pendingDispatch(w) || takenUp(w)))) && !unrequested(w) && !waitingRequest(w, told);

/**
 * The agent a job fits (W-557, Alex 11-18), or null for no preference. Codex: rounds whose brief is the spec (fixes,
 * PR feedback, red CI, a Sentry fix the scout proposed). Claude: planning, research and discovery. A record's model or
 * effort override wins (no preference); reviews are Claude only and decided in place() (W-556).
 */
export function preferredAgent(w, job, byId = new Map()) {
  if (w.model || w.effort) return null;
  if (job?.type === 'fixes' || w.kind === 'pr-feedback' || w.source?.by === 'board (ci)' || byId.get(w.proposedFrom)?.kind === 'scout') return 'codex';
  if (w.repo === 'project-planning' || ['research', 'discovery'].includes(w.kind)) return 'claude';
  return null;
}
const FALLBACK_MS = 20 * 60000;

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
const running = (workers, told) => w => (BUILDING.includes(w.phase) && !waitingRequest(w, told)) || (w.assignments || []).some(a => (a.kind !== 'review' || workers.has(a.owner)) && ['started', 'blocked'].includes(a.status));
const workersOf = cfg => new Set(Object.values(cfg.supervisors || {}).map(s => s?.worker).filter(Boolean));

/** Busy streams and what holds each: running work first, then queued assignments and unacked dispatches, then draining. */
export function busyStreams(works, cfg) {
  const labels = Object.keys(cfg.supervisors || {}), busy = new Map();
  const told = cfg.toldRequests || new Set();
  for (const pass of [running(workersOf(cfg), told), active(told)]) for (const w of works) { const to = routeOf(w, labels); if (to && !holdsNone(w) && pass(w) && !busy.has(to)) busy.set(to, w.id); }
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
  if (liveJob(w) && routeOf(w, labels)) return { to: w.stream, why: 'its worker is mid-job on it' };
  const near = [w.parent, ...(w.related || []).filter(r => r.kind === 'same-work').map(r => r.to), ...(w.deps || [])]
    .map(id => byId.get(id)).filter(o => o && !TERMINAL.includes(o.phase) && liveJob(o) && routeOf(o, labels));
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
  const busy = busyStreams(works, cfg), workers = workersOf(cfg), told = cfg.toldRequests || new Set(), isRunning = running(workers, told);
  // Priority work (priority 1) cuts in behind whatever a stream is running, ahead of anything queued there.
  const runningOn = new Map();
  for (const w of works) { const to = routeOf(w, labels); if (to && !holdsNone(w) && isRunning(w) && !runningOn.has(to)) runningOn.set(to, w.id); }
  for (const [to, why] of cfg.drain || []) runningOn.set(to, why);
  const out = [], byId = new Map(works.map(w => [w.id, w])), load = streamLoad(works, labels);
  const order = works.filter(w => (['ready', 'queued'].includes(w.phase) && !(w.phase === 'queued' && !unrequested(w))) || waitingRequest(w, told))
    .sort(queueOrder);
  const place = w => {
    const job = waitingRequest(w, told);
    const wait = reason => out.push({ id: w.id, action: null, reason, ...(job ? { request: `${w.id}/${job.id}` } : {}) });
    const holds = w.priority === 1 ? runningOn : busy;
    const track = trackOf(w, cfg);
    if (track === 'excluded') { wait('Excluded in config.autoDispatch.exclude'); return; }
    if (track === 'trusted-review') { wait('a trusted review, not stream work'); return; }
    if (w.kind === 'factory') { wait('a factory record: the factory developer builds it'); return; }
    if (w.intakeHold) { wait(`intake hold by ${w.intakeHold.by}`); return; }
    // A project's task starts only once the project is ready for it (projects phase B, Alex 11-16).
    if (!job && w.projectGate && !w.projectGate.ready) { wait(`project ${w.projectGate.slug} isn't ready for it: ${w.projectGate.reasons.join('; ')}`); return; }
    if (w.owner && terminals.includes(w.owner)) { wait(`owner ${w.owner} runs in Terminals`); return; }
    // GitHub's fixes round (CI red, changes requested) reaches its supervisor anyway; it parks on a question if it needs one (W-544, W-566).
    const githubRound = job?.type === 'fixes' && job.by === 'github';
    // A waiting round's derived wait names its stream picking it up, which is this queue, not a blocker; a question doesn't hold GitHub's round.
    if (w.waitingOn && !(job && (labels.includes(w.waitingOn.who) || workers.has(w.waitingOn.who))) && !(githubRound && /^TB-\d+$/.test(w.waitingOn.who))) { wait(`waiting on ${w.waitingOn.who}: ${w.waitingOn.what}`); return; }
    if (w.owner && !labels.includes(w.owner) && !workers.has(w.owner)) { wait(`owned by ${w.owner}, not a stream`); return; }
    if (w.openQuestions > 0 && !githubRound) { wait(`${w.openQuestions} open question(s)`); return; }
    if (w.openDeps?.length) { wait(`waiting on ${w.openDeps.join(', ')}`); return; }
    if (w.externalDeps?.length) { wait(`external dependency: ${w.externalDeps.map(d => d.text || d.ref).join('; ')}`); return; }
    if (needsPrApproval(w, cfg.prApproval)) { wait("needs Alex's go to open a new PR (dashboard: New PRs)"); return; }
    if (w.proposal && !w.links?.pr && w.prApproval && !(w.duplicateCheckedAt >= w.prApproval.at)) { wait('re-checking open PRs for a duplicate since the approval (W-471)'); return; }
    // The internal review is the pre-ready gate and runs on Claude whichever agent built the PR (W-556): never on Codex.
    const fits = l => !(job?.type === 'review' && cfg.supervisors[l]?.agent === 'codex');
    const found = boundStream(w, byId, labels), bound = found && fits(found.to) ? found : null;
    // A stream that declined this record isn't sent it again unless someone pins it there (W-217).
    const declined = new Set((w.requests || []).filter(r => r.type === 'dispatch' && r.ack?.outcome === 'declined').map(r => r.ack.by));
    // A pin to a host stream is a person's deliberate choice (W-356: Alex put OSUP on the host); the host reaches every repo, a sandbox doesn't.
    const hostPin = w.streamPin && (cfg.supervisors[bound?.to]?.repos || cfg.supervisors[bound?.to]?.branches);
    if (bound && !hostPin && !canTake(w, bound.to, cfg.supervisors)) { wait(`${bound.to} can't work in ${w.repo || DEFAULT_REPO}; re-route it`); return; }
    // A model is a Claude alias, so a Codex stream can't run one (deep-model, Alex 11-11); effort suits both.
    const runsModel = l => !(w.model && cfg.supervisors[l]?.agent === 'codex');
    if (bound && !runsModel(bound.to)) { wait(`${bound.to} runs Codex and can't take model ${w.model}; clear the model or re-route it`); return; }
    if (bound && declined.has(bound.to) && !w.streamPin) { wait(`${bound.to} declined it; re-route or pin it`); return; }
    if (bound && holds.has(bound.to)) { wait(`${bound.to} is busy with ${holds.get(bound.to)}; waits its turn (${bound.why})`); return; }
    // ponytail: ties go to config order, not the stream idle longest; add last-dispatch times if one stream keeps winning ties.
    const here = routeOf(w, labels), mine = STREAM_LOAD.includes(w.phase) ? here : null;
    const cost = l => load[l] // this record's own slot doesn't count against its stream
      - (l === mine ? 1 : 0);
    const free = labels.filter(l => !holds.has(l) && !declined.has(l) && canTake(w, l, cfg.supervisors) && runsModel(l) && fits(l)).sort((a, b) => cost(a) - cost(b));
    // The agent that fits the job first; after FALLBACK_MS waiting, any free stream, so nothing starves (W-557).
    const wantAgent = bound ? null : preferredAgent(w, job, byId), agentOf = l => cfg.supervisors[l]?.agent || 'claude';
    const since = job?.at || w.triage?.at || w.createdAt, fallback = cfg.agentFallbackMs ?? FALLBACK_MS;
    const waited = !cfg.now || !since || Date.parse(cfg.now) - Date.parse(since) >= fallback;
    const fitting = wantAgent ? free.filter(l => agentOf(l) === wantAgent) : free;
    if (wantAgent && !fitting.length && free.length && !waited && labels.some(l => agentOf(l) === wantAgent && canTake(w, l, cfg.supervisors))) {
      wait(`waits for a ${wantAgent === 'codex' ? 'Codex' : 'Claude'} stream (its kind of job); any free stream takes it after ${Math.round(fallback / 60000)} min`); return;
    }
    const to = bound?.to || (fitting.length ? fitting : free)[0];
    if (!to && labels.some(l => !holds.has(l) && !fits(l))) { wait(`an internal review runs on Claude, and every Claude stream is busy (${[...holds].filter(([l]) => fits(l)).map(([l, id]) => `${l} with ${id}`).join(', ')}); waits its turn`); return; }
    if (!to) { wait(`every stream is busy (${[...holds].map(([l, id]) => `${l} with ${id}`).join(', ')}); waits its turn`); return; }
    busy.set(to, w.id); runningOn.set(to, w.id);
    if (job) { out.push({ id: w.id, action: to === w.stream ? 'deliver' : 'route', to, request: `${w.id}/${job.id}`, reason: `its ${job.type} round: ${to} is free${bound ? ` (${bound.why})` : to === w.stream ? '' : `, ${w.stream} is busy with ${busy.get(w.stream) || holds.get(w.stream)}`}` }); return; }
    // An sbx worker restarts with the record's model and effort before it's dispatched; a host worker is started with them.
    const want = { model: w.model || null, effort: w.effort || null }, have = { model: null, effort: null, ...cfg.running?.[to] };
    if (cfg.supervisors[to]?.worker && (want.model !== have.model || want.effort !== have.effort)) {
      out.push({ id: w.id, action: 'retune', to, want, reason: `${cfg.supervisors[to].worker} restarts first with model ${want.model || 'default'}, effort ${want.effort || 'default'}` });
      return;
    }
    const flags = !cfg.supervisors[to]?.worker && (w.model || w.effort) ? `; start its worker with ${[w.model && `--model ${w.model}`, w.effort && `--effort ${w.effort}`].filter(Boolean).join(' ')}` : '';
    const spread = labels.map(l => `${l}: ${cost(l)}`).join(', ');
    if (mine) load[mine]--;
    load[to]++;
    const owner = to !== w.stream ? to : undefined;
    out.push({ id: w.id, action: w.phase === 'ready' ? 'queue' : 'request', owner, to,
      reason: `${w.priority === 1 ? 'priority: ' : ''}${w.phase}, no open questions or dependencies, ${to} is free${bound ? ` (${bound.why})` : `, least loaded (${spread})`}${flags}` });
  };
  // Priority and support work go before any job not mid-flight, a parked job's resume included (Alex, 11-09).
  const first = w => w.priority === 1 || w.support;
  order.filter(first).forEach(place);
  for (const w of works.filter(parkedOnly)) {
    const p = (w.parked || []).find(x => x.cleared), to = routeOf(w, labels);
    if (!p || !to) continue;
    if (busy.has(to)) { out.push({ id: w.id, action: null, reason: `${p.waitingOn} cleared; ${to} is busy with ${busy.get(to)}, resumes next` }); continue; }
    busy.set(to, w.id); runningOn.set(to, w.id);
    out.push({ id: w.id, action: 'resume', to, assignmentId: p.assignmentId, version: p.version, reason: `${p.why || `${p.waitingOn} cleared`}, ${to} is free` });
  }
  order.filter(w => !first(w)).forEach(place);
  return out;
}
