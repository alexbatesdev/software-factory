// The one factory queue (W-505), as the dashboard shows it: what each stream runs, then every job in the order the
// dispatch plan will hand it out, then what is held for something other than a free stream. Read-only.
import { REVIEWING } from '../core/work.mjs';

const NOT_QUEUE = /^(Excluded in config|a trusted review|a factory record)/;
const forStream = p => !!p.action || /busy|waits its turn/.test(p.reason || '');
const NEXT = { queue: 'going to', request: 'going to', deliver: 'going to', route: 'moving to', resume: 'resuming on', retune: 'restarting the worker on', offer: 'offered to' };

/** @param plan the last autoDispatchPlan, in placement order @param busy [[stream, what it runs]] */
export function queueView(state, plan, busy, supervisors) {
  const running = new Map(busy);
  const item = (p, i) => {
    const w = state.work[p.id] || {}, r = p.request && (w.requests || []).find(x => `${w.id}/${x.id}` === p.request);
    const type = r?.type || (p.request ? (REVIEWING.includes(w.phase) ? 'review' : 'fixes') : null);
    return { pos: i + 1, id: p.id, title: w.title || null, job: type ? `${type} round (${p.request.split('/')[1]})` : p.action === 'resume' ? `resume ${p.assignmentId}` : 'new work',
      next: p.action ? `${NEXT[p.action] || p.action} ${p.to}` : null, reason: p.reason, support: !!w.support, priority: w.priority ?? 3 };
  };
  const listed = plan.filter(p => !NOT_QUEUE.test(p.reason || ''));
  return {
    streams: supervisors.map(label => ({ label, busyWith: running.get(label) || null, title: state.work[running.get(label)]?.title || null })),
    queue: listed.filter(forStream).map(item),
    held: listed.filter(p => !forStream(p)).map((p, i) => ({ ...item(p, i), pos: null })),
  };
}
