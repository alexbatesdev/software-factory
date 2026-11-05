import { PREFIX } from './notifier.mjs';
// Who to wake: seats with unacked messages they haven't been woken for, plus one reminder after remindMs. Pure.
/**
 * @param woken {seat: {at: ms, ids: [M-n], session}} from earlier wakes @param sessions {seat: agent session id now}
 * @returns [{seat, ids, reminder}]
 */
export function wakePlan(state, woken, nowMs, remindMs = 20 * 60000, sessions = {}) {
  const open = new Map();
  for (const m of Object.values(state.messages)) if (!m.ackedAt) open.set(m.to, [...(open.get(m.to) || []), m.id]);
  const out = [];
  for (const [seat, ids] of open) {
    const w = woken[seat];
    // A restarted seat (new session) never saw the earlier wake.
    const fresh = !w || ids.some(id => !w.ids.includes(id)) || !!(w.session && sessions[seat] && sessions[seat] !== w.session);
    if (fresh || nowMs - w.at >= remindMs && !w.reminded) out.push({ seat, ids, reminder: !fresh });
  }
  return out;
}

export const wakeText = ({ seat, ids, reminder }) =>
  `${PREFIX} ${seat}: ${ids.length} unread message(s) in your factory inbox${reminder ? ' (reminder)' : ''}. Read them with the board inbox tool and ack each.`;
