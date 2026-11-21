// Questions for Alex: asked by a seat, answered by Alex through local-head, routed by the questions router, acked by whoever acts.
const fail = msg => { throw new Error(msg); };

/** Apply an ask / answer / route / question_ack / question_amend row to state.questions in place; returns the question id. */
export function foldQuestion(state, { kind, target, payload: p, ctx }) {
  if (kind === 'ask') {
    if (!p.title) fail('A question needs a title.');
    if (p.work && !state.work[p.work]) fail(`There is no work item ${p.work}.`);
    // A question raised by PR feedback names its review thread, so the factory can ask it there (Alex, 11-20, W-639).
    if (p.audience != null && !['product', 'dev'].includes(p.audience)) fail('audience is product (the Teamwork task decides it) or dev (the PR decides it).');
    let thread = null;
    if (p.threadId) {
      const w = state.work[p.work] || fail('A question on a review thread needs the work item whose PR has it.');
      if (!(w.findings || []).some(f => f.source?.type === 'threads' && f.source.ids?.includes(p.threadId))) fail(`GitHub never reported thread ${p.threadId} on ${p.work}'s PR.`);
      thread = { id: p.threadId, pr: w.links.pr, url: null, postedAt: null };
    }
    const id = `TB-${state.nextQuestion++}`;
    // Origin fields carry where the question came from (Alex, 10-22: every decision names what prompted it).
    const origin = Object.fromEntries(['promptedBy', 'why', 'ac', 'recommendWhy', 'item', 'wwbd'].map(k => [k, p[k] ?? null]));
    state.questions[id] = { title: p.title, options: p.options || [], recommend: p.recommend || null, work: p.work || null, ...origin, from: ctx.by, source: 'inbox', verification: 'verified', status: 'open', at: ctx.now, ...(thread && { thread }), ...(p.audience && { audience: p.audience }) };
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
  } else if (kind === 'question_verify') {
    // V1's triage runs filed questions unverified; the factory lead now decides whether each one should reach Alex.
    if (q.status !== 'open' || q.verification !== 'unverified') fail(`${target} is already verified or settled.`);
    if (!p.note) fail('Verifying a question needs a note saying why.');
    Object.assign(next, p.keep ? { verification: 'verified' } : { status: 'superseded' }, { verificationNote: String(p.note).slice(0, 500), verificationSource: `verified by ${ctx.by}` });
  } else if (kind === 'question_close') {
    // Settled without an answer, e.g. Alex merged the record's PR past it (W-248).
    if (q.status !== 'open') fail(`${target} is not open.`);
    Object.assign(next, { status: 'superseded', verificationNote: String(p.note || '').slice(0, 500), verificationSource: `closed by ${ctx.by}` });
  } else if (kind === 'question_thread') {
    // The factory asked it on its review thread; a teammate's reply there answers it.
    if (!q.thread) fail(`${target} names no review thread.`);
    if (q.thread.postedAt) fail(`${target} is already on its thread.`);
    next.thread = { ...q.thread, url: p.url || null, postedAt: ctx.now };
  } else if (kind === 'question_route') {
    // W-640: asked where its owners decide it, the Teamwork task (product) or the PR discussion (dev).
    if (q.route) fail(`${target} was already asked on ${q.route.channel}.`);
    if (!['teamwork', 'pr'].includes(p.channel) || !p.target) fail('A routed question names its channel (teamwork or pr) and target.');
    next.route = { channel: p.channel, target: String(p.target), url: p.url || null, postedAt: ctx.now };
  } else if (kind === 'question_reply') {
    // A teammate's reply where the factory asked it; local-head judges whether it answers (Alex, 11-21).
    if (!p.id) fail('A reply needs its comment id.');
    if (!(q.replies || []).some(r => r.id === p.id)) next.replies = [...(q.replies || []), { id: p.id, by: p.by, body: String(p.body || '').slice(0, 2000), url: p.url || null, place: p.place || null, at: ctx.now }];
  } else if (kind === 'question_amend') {
    if (q.status !== 'open') fail(`${target} is not open; ask again instead.`);
    if (!p.note) fail('An amendment needs a note.');
    next.amendments = [...(q.amendments || []), { note: String(p.note).slice(0, 2000), by: ctx.by, at: ctx.now }];
  } else fail(`Unknown question command "${kind}".`);
  state.questions[target] = next;
  return target;
}
