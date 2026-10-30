// Questions for Alex: asked by a seat, answered by Alex through local-head, routed by the questions router, acked by whoever acts.
const fail = msg => { throw new Error(msg); };

/** Apply an ask / answer / route / question_ack row to state.questions in place; returns the question id. */
export function foldQuestion(state, { kind, target, payload: p, ctx }) {
  if (kind === 'ask') {
    if (!p.title) fail('A question needs a title.');
    if (p.work && !state.work[p.work]) fail(`There is no work item ${p.work}.`);
    const id = `TB-${state.nextQuestion++}`;
    state.questions[id] = { title: p.title, options: p.options || [], recommend: p.recommend || null, work: p.work || null, from: ctx.by, source: 'inbox', verification: 'verified', status: 'open', at: ctx.now };
    return id;
  }
  const q = state.questions[target] || fail(`There is no question ${target}.`);
  const next = structuredClone(q);
  if (kind === 'answer') {
    if (q.status === 'superseded') fail(`${target} was superseded by a later triage.`);
    const choice = p.choice === 'rec' ? q.recommend : p.choice;
    const key = choice ? (q.options || []).find(o => o.key.toLowerCase() === String(choice).toLowerCase())?.key || fail(`${target} has no option (${choice}).`) : null;
    next.status = 'answered';
    next.answer = { choice: key, note: String(p.note || '').slice(0, 2000), at: ctx.now, by: ctx.by };
  } else if (kind === 'route') {
    if (q.status !== 'answered' || !p.to) fail(`${target} needs an answer and a "to" before it can be routed.`);
    next.answer = { ...q.answer, routeTo: p.to, routedBy: ctx.by, routedAt: ctx.now, routes: [...(q.answer.routes || []), { to: p.to, by: ctx.by, note: String(p.note || '').slice(0, 500), at: ctx.now }] };
  } else if (kind === 'question_ack') {
    if (q.status !== 'answered') fail(`${target} has no answer to acknowledge.`);
    if (q.answer.routeTo && q.answer.routeTo !== ctx.by) fail(`${target} was routed to ${q.answer.routeTo}; only that seat acknowledges it.`);
    next.answer = { ...q.answer, ack: { by: ctx.by, outcome: p.outcome || 'received', note: p.note || null, at: ctx.now } };
  } else fail(`Unknown question command "${kind}".`);
  state.questions[target] = next;
  return target;
}
