// Cycling a worker's host when its disk fills (Alex, 11-04: at 75%, between tasks). Pure: the host adapter does the cycling.
import { LIVE_ASSIGNMENT } from './work.mjs';

/**
 * Which streams drain (take no new work) and which workers are ready to cycle now.
 * @param health {unitId: {diskPct}} from the host adapter; a unit with no reading is left alone
 * @param recycling {unitId: {step, failed?}} cycles under way or failed; their streams stay drained
 * @param supervisors configured stream labels: nothing else is touched (Mutation is Alex's own)
 * @returns {{drain: Map(stream label → reason), due: [{unit, to, worker, diskPct}]}}
 */
export function planRecycles({ units, health = {}, works, threshold = 0.75, recycling = {}, supervisors = [] }) {
  const drain = new Map(), due = [];
  for (const u of units) {
    const to = u.supervisor?.label, h = health[u.id];
    if (!u.worker || !supervisors.includes(to)) continue;
    if (recycling[u.id]) { drain.set(to, recycling[u.id].failed ? `${u.worker.label} recycle failed: ${recycling[u.id].failed}` : `recycling ${u.worker.label} (${recycling[u.id].step})`); continue; }
    if (!h || h.diskPct < threshold) continue;
    drain.set(to, `${u.worker.label} disk at ${Math.round(h.diskPct * 100)}%: recycled after its running job`);
    // Between tasks: nothing started or blocked on the stream, and the worker's agent has stopped.
    const busy = Object.values(works).some(r => r.stream === to && (r.assignments || []).some(a => LIVE_ASSIGNMENT.includes(a.status) && a.status !== 'queued'));
    if (!busy && ['idle', 'done'].includes(u.worker.status)) due.push({ unit: u.id, to, worker: u.worker, diskPct: h.diskPct });
  }
  return { drain, due };
}
