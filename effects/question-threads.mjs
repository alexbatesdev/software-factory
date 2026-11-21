import { CODEX } from '../core/threads.mjs';
// W-639 (Alex, 11-20): a question raised by PR feedback is asked on its review thread. Posting is off unless
// config.prThreadQuestions.enabled; replies to questions already posted are always read. Whether a reply answers the
// question is an agent's call, never this code's (Alex, 11-21): "I've asked the customer" is a reply, not an answer.
const BY = 'factory (PR thread question)';
const bot = (login, me) => !login || login === me || login === CODEX || login === 'ghost' || /\[bot\]$/.test(login);
// Posted as Alex: no @mention pings anyone, and no local paths leave the machine.
const scrub = s => String(s || '').replace(/(~|\/Users\/[^\s/]+)\/\S+/g, '(a local file)').replace(/@([\w-]+)/g, '`@$1`').trim();

export function questionBody(id, q, where = 'on this thread') {
  const opts = (q.options || []).map(o => `- **${o.key}**: ${scrub(o.text)}${o.key === q.recommend ? ' (recommended)' : ''}`);
  return ['🤖', `**A decision for the team (${id})**`, '', scrub(q.title),
    ...(q.why ? ['', scrub(q.why)] : []), ...(opts.length ? ['', ...opts] : []), ...(q.recommendWhy ? ['', `Why the recommendation: ${scrub(q.recommendWhy)}`] : []),
    '', `Reply ${where}${opts.length ? ' with the option letter, or' : ' with'} your answer in words. If you need to check with someone first, say so here; the question stays open.`, '🤖'].join('\n');
}

export const JUDGE = 'local-head';

/**
 * Each new reply after our post is recorded on the question (and so is never PR feedback) and sent to local-head, which
 * records Alex's answers: it answers the TB from the reply when it is one, or notes it on the record and leaves it open.
 */
function relayReplies(store, id, q, replies, place, now, log) {
  for (const r of replies.filter(r => !(q.replies || []).some(x => x.id === r.id))) {
    store.append({ kind: 'question_reply', target: id, payload: { id: r.id, by: String(r.by), body: String(r.body).slice(0, 2000), url: r.url || null, place } }, { now: now(), by: BY });
    store.append({ kind: 'message', payload: { to: JUDGE, work: q.work, about: { questionReply: `${id}/${r.id}` },
      text: `[software factory, automated, not Alex] ${r.by} replied to ${id} ("${String(q.title).slice(0, 120)}") on ${place}: "${String(r.body).slice(0, 1500)}" ${r.url || ''} Judge it: if it settles the question, \`answer\` ${id} (the option it picks, or none) with a note quoting it and naming ${r.by}. If it doesn't (unsure, asked someone else, a follow-up question), leave ${id} open and \`progress\` ${q.work} with what they said. Either way ack this message.` } }, { now: now(), by: BY });
    log(`${place}: ${r.by} replied to ${id}, sent to ${JUDGE} to judge`);
  }
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
        log(`PR thread questions: asked ${id} on ${url}`);
        continue;
      }
      const replies = (await gh.threadComments(q.thread.id)).filter(c => c.at > q.thread.postedAt && !bot(c.by, me)).map(c => ({ ...c, id: c.id || c.url }));
      relayReplies(store, id, q, replies, `the review thread ${q.thread.url || q.thread.id}`, now, log);
    } catch (e) { log(`PR thread question ${id}: ${e.message}`); }
  }
}

const twId = w => w?.source?.type === 'teamwork' && /^tw-(\d+)$/.exec(w.source.key || '')?.[1] || null;

/**
 * W-640 (Alex, 11-21): with config.decisionRouting.enabled, a product question is also asked on its record's Teamwork
 * task and a dev question in its PR's discussion; replies there go to local-head to judge (relayReplies). A
 * question with no task or PR stays on the dashboard only. A review-thread question (W-639, when on) goes there instead.
 */
export async function syncQuestionRoutes(store, { gh, tw }, now, { me, enabled = false, threadsOn = false, prState = () => null, log = () => {} } = {}) {
  for (const [id, q] of Object.entries(store.state.questions)) {
    if (q.status !== 'open' || !['product', 'dev'].includes(q.audience) || q.thread?.postedAt || (q.thread && threadsOn)) continue;
    const w = store.state.work[q.work];
    try {
      if (!q.route) {
        const channel = q.audience === 'product' ? 'teamwork' : 'pr', target = channel === 'teamwork' ? twId(w) : w?.links?.pr;
        if (!target || (channel === 'pr' && ['MERGED', 'CLOSED'].includes(prState(target)))) continue;
        if (!enabled) { log(`decision routing (off): would ask ${id} on ${channel} ${target}`); continue; }
        if (channel === 'pr') {
          const earlier = (await gh.prComments(target)).find(c => c.by === me && c.body.includes(`(${id})`));
          const url = earlier?.url || await gh.prComment(target, questionBody(id, q, 'here'));
          store.append({ kind: 'question_route', target: id, payload: { channel, target, url } }, { now: now(), by: BY });
          log(`decision routing: asked ${id} in the PR discussion ${url}`);
        } else {
          const { me: twMe, comments } = await tw.comments(target);
          if (!comments.some(c => c.by === twMe && c.body.includes(`(${id})`))) await tw.post(target, questionBody(id, q, 'on this task').replace(/\*\*/g, ''));
          store.append({ kind: 'question_route', target: id, payload: { channel, target } }, { now: now(), by: BY });
          log(`decision routing: asked ${id} on Teamwork task ${target}`);
        }
        continue;
      }
      const { channel, target, postedAt } = q.route;
      let replies;
      if (channel === 'pr') replies = (await gh.prComments(target)).filter(c => c.at > postedAt && !bot(c.by, me));
      else {
        const { me: twMe, comments } = await tw.comments(target);
        replies = comments.filter(c => c.at > postedAt && c.by !== twMe && c.body.trim() && !c.sync).map(c => ({ ...c, by: `Teamwork user ${c.by}` }));
      }
      replies.sort((a, b) => a.at.localeCompare(b.at));
      relayReplies(store, id, q, replies, channel === 'pr' ? `the PR discussion of ${target}` : `Teamwork task ${target}`, now, log);
    } catch (e) { log(`decision routing ${id}: ${e.message}`); }
  }
}
