// Cycling a worker's host when its disk fills (Alex, 11-04: at 75%, between tasks). Pure: the host adapter does the cycling.
import { LIVE_ASSIGNMENT, parked } from './work.mjs';

/**
 * Which streams drain (take no new work) and which workers are ready to cycle now.
 * @param health {unitId: {diskPct}} from the host adapter; a unit with no reading is left alone
 * @param recycling {unitId: {step, failed?}} cycles under way or failed; their streams stay drained
 * @param supervisors configured stream labels: nothing else is touched (Mutation is Alex's own)
 * @returns {{drain: Map(stream label → reason), due: [{unit, to, worker, diskPct}]}}
 */
// A worker restarts fresh between jobs (~/Code/CLAUDE.md: recycle at every boundary) once its stream has been quiet this long.
const QUIET_MS = 180000;
export function planRecycles({ units, health = {}, works, threshold = 0.75, recycling = {}, supervisors = [], sessions = {}, now = Date.now(), restartStale = false }) {
  const drain = new Map(), due = [];
  for (const u of units) {
    const to = u.supervisor?.label, h = health[u.id];
    if (!u.worker || !supervisors.includes(to)) continue;
    if (recycling[u.id]) { drain.set(to, recycling[u.id].failed ? `${u.worker.label} recycle failed: ${recycling[u.id].failed}` : `recycling ${u.worker.label} (${recycling[u.id].step})`); continue; }
    if (!h || h.diskPct < threshold) {
      // Stale session: it finished a job (or someone wrote on its stream) after it started, and the stream is quiet now.
      const mine = Object.values(works).filter(r => r.stream === to);
      const last = Math.max(0, ...mine.flatMap(r => [...(r.assignments || []).flatMap(a => (a.history || []).filter(x => x.status === 'done').map(x => Date.parse(x.at))),
        ...(r.updates || []).filter(x => [to, u.worker.label].includes(x.by)).map(x => Date.parse(x.at))]));
      const busy = mine.some(r => (r.assignments || []).some(a => ['started', 'blocked'].includes(a.status) && !parked(a)));
      if (restartStale && sessions[u.id] && sessions[u.id] < last && now - last >= QUIET_MS && !busy && ['idle', 'done'].includes(u.worker.status))
        due.push({ unit: u.id, to, worker: u.worker, restart: true });
      continue;
    }
    drain.set(to, `${u.worker.label} disk at ${Math.round(h.diskPct * 100)}%: recycled after its running job`);
    // Between tasks: nothing started or blocked on the stream, and the worker's agent has stopped.
    const busy = Object.values(works).some(r => r.stream === to && (r.assignments || []).some(a => LIVE_ASSIGNMENT.includes(a.status) && a.status !== 'queued'));
    if (!busy && ['idle', 'done'].includes(u.worker.status)) due.push({ unit: u.id, to, worker: u.worker, diskPct: h.diskPct });
  }
  return { drain, due };
}
