import { CODEX } from '../core/threads.mjs';
// W-639 (Alex, 11-20): a question raised by PR feedback is asked on its review thread, and a teammate's reply there
// answers it. Posting is off unless config.prThreadQuestions.enabled; replies to questions already posted are always read.
const BY = 'factory (PR thread question)';
const bot = (login, me) => !login || login === me || login === CODEX || login === 'ghost' || /\[bot\]$/.test(login);
// Posted as Alex: no @mention pings anyone, and no local paths leave the machine.
const scrub = s => String(s || '').replace(/(~|\/Users\/[^\s/]+)\/\S+/g, '(a local file)').replace(/@([\w-]+)/g, '`@$1`').trim();

export function questionBody(id, q) {
  const opts = (q.options || []).map(o => `- **${o.key}**: ${scrub(o.text)}${o.key === q.recommend ? ' (recommended)' : ''}`);
  return ['🤖', `**A decision for the team (${id})**`, '', scrub(q.title),
    ...(q.why ? ['', scrub(q.why)] : []), ...(opts.length ? ['', ...opts] : []), ...(q.recommendWhy ? ['', `Why the recommendation: ${scrub(q.recommendWhy)}`] : []),
    '', `Reply on this thread${opts.length ? ' with the option letter, or' : ' with'} your answer in words. The first reply is taken as the answer.`, '🤖'].join('\n');
}

/** The option a reply picks: its first word, e.g. "b", "b)", "Option B". */
export function pickOption(body, options = []) {
  const m = String(body || '').trim().match(/^(?:option\s+)?\**([a-z0-9]+)\**(?=$|[\s).:,!-])/i);
  return m && options.find(o => o.key.toLowerCase() === m[1].toLowerCase())?.key || null;
}

export async function syncQuestionThreads(store, gh, now, { me, enabled = false, prState = () => null, log = () => {} } = {}) {
  for (const [id, q] of Object.entries(store.state.questions)) {
    if (q.status !== 'open' || !q.thread) continue;
    if (['MERGED', 'CLOSED'].includes(prState(q.thread.pr))) continue;
    try {
      if (!q.thread.postedAt) {
        if (!enabled) { log(`PR thread questions (off): would ask ${id} on ${q.thread.id}`); continue; }
        const t = await gh.thread(q.thread.id);
        if (!t || t.pr !== q.thread.pr || t.isResolved) continue;
        // A post whose record didn't land (a crash in between) is found again rather than posted twice.
        const earlier = (await gh.threadComments(q.thread.id)).find(c => c.by === me && c.body.includes(`(${id})`));
        const url = earlier?.url || await gh.replyThread(q.thread.id, questionBody(id, q));
        store.append({ kind: 'question_thread', target: id, payload: { url } }, { now: now(), by: BY });
        continue;
      }
      const reply = (await gh.threadComments(q.thread.id)).find(c => c.at > q.thread.postedAt && !bot(c.by, me));
      if (!reply) continue;
      store.append({ kind: 'answer', target: id, payload: { choice: pickOption(reply.body, q.options), note: `${reply.by} answered on the PR thread: ${reply.body}\n${reply.url}` } }, { now: now(), by: `${reply.by} (PR thread)` });
    } catch (e) { log(`PR thread question ${id}: ${e.message}`); }
  }
}
