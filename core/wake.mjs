// Who to wake: seats with unacked messages they haven't been woken for, plus one reminder after remindMs. Pure.
/**
 * @param woken {seat: {at: ms, ids: [M-n]}} from earlier wakes
 * @returns [{seat, ids, reminder}]
 */
export function wakePlan(state, woken, nowMs, remindMs = 20 * 60000) {
  const open = new Map();
  for (const m of Object.values(state.messages)) if (!m.ackedAt) open.set(m.to, [...(open.get(m.to) || []), m.id]);
  const out = [];
  for (const [seat, ids] of open) {
    const w = woken[seat];
    const fresh = !w || ids.some(id => !w.ids.includes(id));
    if (fresh || nowMs - w.at >= remindMs && !w.reminded) out.push({ seat, ids, reminder: !fresh });
  }
  return out;
}

export const wakeText = ({ seat, ids, reminder }) =>
  `[software factory, automated, not Alex] ${seat}: ${ids.length} unread message(s) in your factory inbox${reminder ? ' (reminder)' : ''}. Read them with the board inbox tool and ack each.`;
