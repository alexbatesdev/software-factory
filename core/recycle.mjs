import { createHash } from 'node:crypto';
// Cycling a worker's host when its disk fills (Alex, 11-04: at 75%, between tasks). Pure: the host adapter does the cycling.
import { parked, TERMINAL, workIdOf } from './work.mjs';

/**
 * Which streams drain (take no new work) and which workers are ready to cycle now.
 * @param health {unitId: {diskPct}} from the host adapter; a unit with no reading is left alone
 * @param recycling {unitId: {step, failed?}} cycles under way or failed; their streams stay drained
 * @param supervisors configured stream labels: nothing else is touched (Mutation is Alex's own)
 * @param hardStop past this a running job is named for parking, so a long job can't fill the disk (W-550)
 * @returns {{drain: Map(stream label → reason), due: [{unit, to, worker, diskPct}], stop: Map(stream label → {work, assignment, diskPct})}}
 */
// A worker restarts fresh between jobs (~/Code/CLAUDE.md: recycle at every boundary) once its stream has been quiet this long.
const QUIET_MS = 180000;
/** A job is started or blocked on the stream and not parked (a parked job's handoff is written; the stream is free). */
export const streamBusy = (works, stream) => Object.values(works).some(r => r.stream === stream && (r.assignments || []).some(a => ['started', 'blocked'].includes(a.status) && !parked(a)));
export function planRecycles({ units, health = {}, works, threshold = 0.75, hardStop = 0.9, recycling = {}, supervisors = [], sessions = {}, now = Date.now(), restartStale = false }) {
  const drain = new Map(), due = [], stop = new Map();
  for (const u of units) {
    const to = u.supervisor?.label, h = health[u.id];
    if (!u.worker || !supervisors.includes(to)) continue;
    if (recycling[u.id]) { drain.set(to, recycling[u.id].failed ? `${u.worker.label} recycle failed: ${recycling[u.id].failed}` : `recycling ${u.worker.label} (${recycling[u.id].step})`); continue; }
    // No agent in the sandbox (an exit that finished after a restart gave up, W-240): start one, job or not.
    if (restartStale && h && h.agentSince === null) { due.push({ unit: u.id, to, worker: u.worker, restart: true }); continue; }
    if (!h || h.diskPct < threshold) {
      // Stale session: it finished a job (or someone wrote on its stream) after it started, and the stream is quiet now.
      const mine = Object.values(works).filter(r => r.stream === to);
      const last = Math.max(0, ...mine.flatMap(r => [...(r.assignments || []).flatMap(a => (a.history || []).filter(x => x.status === 'done').map(x => Date.parse(x.at))),
        ...(r.updates || []).filter(x => [to, u.worker.label].includes(x.by)).map(x => Date.parse(x.at))]));
      if (restartStale && sessions[u.id] && sessions[u.id] < last && now - last >= QUIET_MS && !streamBusy(works, to) && ['idle', 'done'].includes(u.worker.status))
        due.push({ unit: u.id, to, worker: u.worker, restart: true });
      continue;
    }
    drain.set(to, `${u.worker.label} disk at ${Math.round(h.diskPct * 100)}%: recycled after its running job`);
    if (h.diskPct >= hardStop) for (const r of Object.values(works).filter(r => r.stream === to))
      for (const a of (r.assignments || []).filter(a => ['started', 'blocked'].includes(a.status) && !parked(a))) stop.set(to, { work: r.id, assignment: a.id, diskPct: h.diskPct });
    // Between tasks: nothing running on the stream (a parked job's handoff is written, W-538), and the worker's agent has stopped.
    if (!streamBusy(works, to) && ['idle', 'done'].includes(u.worker.status)) due.push({ unit: u.id, to, worker: u.worker, diskPct: h.diskPct });
  }
  return { drain, due, stop };
}

/** What blocks a recycle, as a dedupe key: a new blocker at the same count is told again (W-543). */
export const blockKey = (sandbox, problems) => `${sandbox}/${createHash('sha1').update(problems.map(p => `${p.path}: ${p.problem}`).sort().join('\n')).digest('hex').slice(0, 12)}`;

/** A worktree named for a finished record holds nothing a later job needs (W-493): it goes with the sandbox, and is named. */
export const releaseFinished = (found, works) => found.map(p => {
  const w = works[workIdOf(p.path.split('/').at(-1))];
  return p.blocking && w && TERMINAL.includes(w.phase) ? { ...p, problem: `${p.problem}, and ${w.id} is ${w.phase}`, blocking: false } : p;
});

/** A disk reading worth a log line (W-552): the first, a move of 5+ points since the last logged one, or a threshold crossed. */
export function diskNote(label, logged, pct, thresholds) {
  if (pct == null) return null;
  const P = x => `${Math.round(x * 100)}%`;
  if (logged == null) return `disk ${label}: ${P(pct)}`;
  const crossed = thresholds.filter(t => (logged < t) !== (pct < t));
  if (!crossed.length && Math.abs(pct - logged) < 0.05) return null;
  return `disk ${label}: ${P(pct)} (was ${P(logged)})${crossed.length ? `, crossed ${crossed.map(P).join(' and ')}` : ''}`;
}
