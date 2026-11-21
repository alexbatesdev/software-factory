// What the factory did through Alex's away toggles (W-639 review threads, W-640 decision routing), read from the event
// store: each question it asked off the dashboard, the replies there, how each was settled, and what followed.
const where = q => q.thread?.postedAt ? { at: q.thread.postedAt, place: `review thread ${q.thread.url || q.thread.id}` }
  : q.route ? { at: q.route.postedAt, place: q.route.channel === 'pr' ? `PR discussion ${q.route.url || q.route.target}` : `Teamwork task ${q.route.target}` } : null;
const line = s => String(s || '').replace(/\s+/g, ' ').trim();

export function awayReport(state, { since, until = '9999' }) {
  const asked = Object.entries(state.questions).map(([id, q]) => ({ id, q, w: where(q) })).filter(x => x.w && x.w.at >= since && x.w.at < until)
    .sort((a, b) => a.w.at.localeCompare(b.w.at));
  const answered = asked.filter(x => x.q.answer), open = asked.filter(x => x.q.status === 'open');
  const replied = asked.filter(x => x.q.replies?.length).length;
  const out = [`# Factory away report, ${since.slice(0, 10)} to ${until === '9999' ? 'now' : until.slice(0, 10)}`, '',
    `- Asked off the dashboard: ${asked.length}. Got a reply: ${replied}. Answered: ${answered.length}. Still open: ${open.length}.`, ''];
  const block = ({ id, q, w }) => {
    const rec = state.work[q.work], a = q.answer;
    out.push(`### ${id} (${q.work}${rec ? `: ${line(rec.title).slice(0, 90)}` : ''})`, '', `- Asked: ${line(q.title)}`, `- Where: ${w.place}, ${w.at}`,
      ...(q.replies?.length ? ['- Replies:', ...q.replies.map(r => `  - ${r.at.slice(0, 16)}Z ${r.by}: ${line(r.body).slice(0, 300)}`)] : ['- Replies: none']));
    if (!a) return out.push('');
    out.push(`- Answered by ${a.by} at ${a.at}${a.choice ? `, option ${a.choice}` : ''}: ${line(a.note).slice(0, 400)}`,
      `- Routed to: ${a.routeTo || 'not yet'}; acted on: ${a.ack ? `${a.ack.by} at ${a.ack.at}` : 'not yet'}`);
    const after = (rec?.updates || []).filter(u => u.at >= a.at && u.at < until);
    out.push(`- What ${q.work} did after it${after.length > 15 ? ` (first 15 of ${after.length})` : ''}:`, ...(after.length ? after.slice(0, 15).map(u => `  - ${u.at.slice(0, 16)}Z ${u.by}: ${line(u.text).slice(0, 200)}`) : ['  - nothing yet']), '');
  };
  if (answered.length) { out.push('## Answered', ''); answered.forEach(block); }
  if (open.length) { out.push('## Still open', ''); open.forEach(block); }
  return out.join('\n');
}
