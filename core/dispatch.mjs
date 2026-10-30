// Auto-dispatch (Alex, 2026-10-28): which ready or queued records start themselves this tick, and why the rest wait.
// Pure: the server applies the plan through ordinary events and logs each one on its record.
import { routeOf } from './notifier.mjs';
import { BUILDING, LIVE_ASSIGNMENT, trackOf } from './work.mjs';

const live = w => (w.assignments || []).some(a => a.kind !== 'review' && LIVE_ASSIGNMENT.includes(a.status));
const pendingDispatch = w => (w.requests || []).some(r => r.type === 'dispatch' && !r.ack);
const takenUp = w => (w.requests || []).some(r => r.type === 'dispatch' && ['received', 'done'].includes(r.ack?.outcome));
// A stream is busy while its worker has a job: building or fixing, a live work assignment, or a dispatch not yet acked.
const active = w => BUILDING.includes(w.phase) || live(w) || (w.phase === 'queued' && pendingDispatch(w));

/** The one stream whose match words appear in the title or objective, with the word that matched. */
export function topicOwner(w, supervisors) {
  const text = `${w.title || ''} ${w.objective || ''}`;
  const word = k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  const hits = Object.entries(supervisors).map(([l, s]) => [l, (s.match || []).find(k => word(k).test(text))]).filter(([, k]) => k);
  return hits.length === 1 ? { owner: hits[0][0], matched: hits[0][1] }
    : { reason: `unrouted: ${hits.length ? `matches ${hits.length} streams (${hits.map(h => h[0]).join(', ')})` : 'no stream topic matches'}; set an owner` };
}

/**
 * @param works server work views (openQuestions, openDeps, intakeHold included)
 * @param cfg {supervisors: {label: {areas, match}}, exclude: [W-n], mutationBranch}
 * @param fleet {terminals: [pane labels running in Terminals]}
 * @returns [{id, action: 'queue'|'request'|null, owner?, reason}] for every ready/queued record not already with its supervisor
 */
export function autoDispatchPlan(works, cfg, { terminals = [] } = {}) {
  const labels = Object.keys(cfg.supervisors || {});
  const busy = new Map();
  // Running work names the busy stream first; queued assignments and unacked dispatches still hold the slot.
  const running = w => BUILDING.includes(w.phase) || (w.assignments || []).some(a => a.kind !== 'review' && ['started', 'blocked'].includes(a.status));
  for (const pass of [running, active]) for (const w of works) { const to = routeOf(w, labels); if (to && pass(w) && !busy.has(to)) busy.set(to, w.id); }
  const out = [];
  const order = works.filter(w => ['ready', 'queued'].includes(w.phase) && !(w.phase === 'queued' && (pendingDispatch(w) || takenUp(w) || live(w))))
    .sort((a, b) => (a.priority ?? 3) - (b.priority ?? 3) || Number(a.id.slice(2)) - Number(b.id.slice(2)));
  for (const w of order) {
    const wait = reason => out.push({ id: w.id, action: null, reason });
    const track = trackOf(w, cfg);
    if (track === 'mutation') { wait('Mutation work is never auto-dispatched'); continue; }
    if (track === 'trusted-review') { wait('a trusted review, not stream work'); continue; }
    if (w.intakeHold) { wait(`intake hold by ${w.intakeHold.by}`); continue; }
    if (w.owner && terminals.includes(w.owner)) { wait(`owner ${w.owner} runs in Terminals`); continue; }
    if (w.openQuestions > 0) { wait(`${w.openQuestions} open question(s)`); continue; }
    if (w.openDeps?.length) { wait(`waiting on ${w.openDeps.join(', ')}`); continue; }
    if (w.externalDeps?.length) { wait(`external dependency: ${w.externalDeps.map(d => d.text || d.ref).join('; ')}`); continue; }
    let to = routeOf(w, labels), owner;
    if (!to) { const t = topicOwner(w, cfg.supervisors || {}); if (!t.owner) { wait(t.reason); continue; } to = owner = t.owner; }
    if (busy.has(to)) { wait(`${to} is busy with ${busy.get(to)}; waits its turn`); continue; }
    busy.set(to, w.id);
    out.push({ id: w.id, action: w.phase === 'ready' ? 'queue' : 'request', owner, to,
      reason: `${w.phase}, no open questions or dependencies, ${to} has no other active work${owner ? `; owner set from topic (${cfg.supervisors[to].areas})` : ''}` });
  }
  return out;
}
