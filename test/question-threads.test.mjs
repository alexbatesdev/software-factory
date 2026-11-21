import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { syncQuestionThreads, questionBody } from '../effects/question-threads.mjs';

const PR = 'https://github.com/acme-org/app/pull/8635', T = '2026-11-20T23:00:00.000Z', ME = 'alex-gh';
const ask = { title: 'Keep the legacy export column, @reviewer-jm?', options: [{ key: 'a', text: 'Keep it' }, { key: 'b', text: 'Drop it, see ~/Code/plans/x.md' }], recommend: 'b', work: 'W-1', wwbd: 'no passage applies', threadId: 'PRRT_abc' };

function setup() {
  const store = openStore(':memory:', { supervisors: ['sup: stream-1'] });
  const ctx = { now: T, by: 'sup: stream-1' };
  store.append({ kind: 'create', payload: { title: 'PR feedback', links: { pr: PR }, stream: 'sup: stream-1' } }, ctx);
  store.append({ kind: 'observe_head', target: 'W-1', payload: { sha: 'aaaaaaa1', via: 'github', isDraft: false } }, ctx);
  store.append({ kind: 'observe_health', target: 'W-1', payload: { head: 'aaaaaaa1', threads: [{ id: 'PRRT_abc', by: 'reviewer-jm', url: `${PR}#discussion_r1` }] } }, ctx);
  return store;
}

function fakeGh(comments = []) {
  const posts = [];
  return { posts, comments,
    thread: async () => ({ pr: PR, isResolved: false }),
    threadComments: async () => comments,
    replyThread: async (id, body) => { posts.push({ id, body }); comments.push({ by: ME, at: '2026-11-20T23:05:00Z', body, url: `${PR}#discussion_r2` }); return `${PR}#discussion_r2`; } };
}

test('a question names only a review thread the GitHub poll reported on its record', () => {
  const store = setup();
  assert.throws(() => store.append({ kind: 'ask', payload: { ...ask, threadId: 'PRRT_other' } }, { now: T, by: 'x' }), /never reported/);
  store.append({ kind: 'ask', payload: ask }, { now: T, by: 'sup: stream-1' });
  assert.deepEqual(store.state.questions['TB-1'].thread, { id: 'PRRT_abc', pr: PR, url: null, postedAt: null });
});

test('with the toggle off nothing is posted; on, the question is posted once as a 🤖 reply with no pings or local paths', async () => {
  const store = setup(), gh = fakeGh(), now = () => '2026-11-20T23:05:01.000Z', logs = [];
  store.append({ kind: 'ask', payload: ask }, { now: T, by: 'sup: stream-1' });
  await syncQuestionThreads(store, gh, now, { me: ME, log: l => logs.push(l) });
  assert.equal(gh.posts.length, 0);
  assert.match(logs[0], /off.*would ask TB-1/);
  await syncQuestionThreads(store, gh, now, { me: ME, enabled: true });
  await syncQuestionThreads(store, gh, now, { me: ME, enabled: true });
  assert.equal(gh.posts.length, 1, 'posted once');
  const body = gh.posts[0].body;
  assert.match(body, /^🤖\n[\s\S]*\n🤖$/);
  assert.match(body, /`@reviewer-jm`/);
  assert.doesNotMatch(body, /[^`]@reviewer|~\/Code/);
  assert.match(body, /\*\*b\*\*: .*\(recommended\)/);
  assert.equal(store.state.questions['TB-1'].thread.url, `${PR}#discussion_r2`);
  assert.equal(store.state.questions['TB-1'].status, 'open', 'still on Alex\'s dashboard');
});

test('a post that landed on GitHub but not in the factory is found again, not posted twice', async () => {
  const store = setup(), gh = fakeGh([{ by: ME, at: '2026-11-20T23:04:00Z', body: questionBody('TB-1', ask), url: `${PR}#discussion_r9` }]);
  store.append({ kind: 'ask', payload: ask }, { now: T, by: 'sup: stream-1' });
  await syncQuestionThreads(store, gh, () => T, { me: ME, enabled: true });
  assert.equal(gh.posts.length, 0);
  assert.equal(store.state.questions['TB-1'].thread.url, `${PR}#discussion_r9`);
});

test('a question with no thread, or on a merged PR, is left alone', async () => {
  const store = setup(), gh = fakeGh();
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined } }, { now: T, by: 'sup: stream-1' });
  store.append({ kind: 'ask', payload: { ...ask, title: 'second' } }, { now: T, by: 'sup: stream-1' });
  await syncQuestionThreads(store, gh, () => T, { me: ME, enabled: true, prState: () => 'MERGED' });
  assert.equal(gh.posts.length, 0);
});

// W-640: decision routing, product to the Teamwork task and dev to the PR discussion.
import { syncQuestionRoutes } from '../effects/question-threads.mjs';

function routed() {
  const store = setup(), ctx = { now: T, by: 'sup: stream-1' };
  store.append({ kind: 'create', payload: { title: 'TW task', source: { type: 'teamwork', key: 'tw-41323957' }, stream: 'sup: stream-1' } }, ctx);
  const posts = [], gh = { ...fakeGh(), prComments: async () => gh.discussion, discussion: [], prComment: async (url, body) => { posts.push({ to: url, body }); return `${PR}#issuecomment-1`; } };
  const tw = { comments: async () => ({ me: 7, comments: tw.list }), list: [], post: async (id, body) => { posts.push({ to: `tw ${id}`, body }); tw.list.push({ id: 'tw-comment-0', by: 7, at: '2026-11-20T23:05:00Z', body }); } };
  return { store, gh, tw, posts };
}

test('an audience is product or dev', () => {
  const { store } = routed();
  assert.throws(() => store.append({ kind: 'ask', payload: { ...ask, threadId: undefined, audience: 'qa' } }, { now: T, by: 'x' }), /audience/);
});

test('decision routing: off logs only; on, dev goes to the PR discussion and product to the Teamwork task, once each', async () => {
  const { store, gh, tw, posts } = routed(), logs = [];
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined, audience: 'dev' } }, { now: T, by: 'sup: stream-1' });
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined, work: 'W-2', audience: 'product' } }, { now: T, by: 'sup: stream-1' });
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined, work: 'W-2', audience: 'dev', title: 'no PR yet' } }, { now: T, by: 'sup: stream-1' });
  await syncQuestionRoutes(store, { gh, tw }, () => T, { me: ME, log: l => logs.push(l) });
  assert.equal(posts.length, 0);
  assert.equal(logs.length, 2, 'the record with no PR stays on the dashboard only');
  await syncQuestionRoutes(store, { gh, tw }, () => '2026-11-20T23:05:01.000Z', { me: ME, enabled: true });
  await syncQuestionRoutes(store, { gh, tw }, () => '2026-11-20T23:05:01.000Z', { me: ME, enabled: true });
  assert.deepEqual(posts.map(p => p.to), [PR, 'tw 41323957']);
  assert.match(posts[0].body, /^🤖[\s\S]*Reply here[\s\S]*🤖$/);
  assert.doesNotMatch(posts[1].body, /\*\*/, 'plain text on Teamwork');
  assert.deepEqual([store.state.questions['TB-1'].route.channel, store.state.questions['TB-2'].route.channel, store.state.questions['TB-3'].route], ['pr', 'teamwork', undefined]);
});

test('with review-thread questions on, a thread question goes to its thread, not the discussion', async () => {
  const { store, gh, tw, posts } = routed();
  store.append({ kind: 'ask', payload: { ...ask, audience: 'dev' } }, { now: T, by: 'sup: stream-1' });
  await syncQuestionRoutes(store, { gh, tw }, () => T, { me: ME, enabled: true, threadsOn: true });
  assert.equal(posts.length, 0);
  await syncQuestionRoutes(store, { gh, tw }, () => T, { me: ME, enabled: true, threadsOn: false });
  assert.equal(posts.length, 1, 'with threads off it goes to the discussion');
});

import { awayReport } from '../core/away-report.mjs';


const messagesTo = (store, seat) => Object.values(store.state.messages).filter(m => m.to === seat);

test('every teammate reply on the thread goes to local-head to judge; none answers the question by itself (Alex, 11-21)', async () => {
  const store = setup(), gh = fakeGh();
  store.append({ kind: 'ask', payload: ask }, { now: T, by: 'sup: stream-1' });
  await syncQuestionThreads(store, gh, () => '2026-11-20T23:05:01.000Z', { me: ME, enabled: true });
  gh.comments.push({ by: 'chatgpt-codex-connector', at: '2026-11-20T23:06:00Z', body: 'a', url: 'u1' },
    { by: 'dependabot[bot]', at: '2026-11-20T23:06:30Z', body: 'a', url: 'u2' }, { by: ME, at: '2026-11-20T23:07:00Z', body: 'a', url: 'u3' },
    { by: 'teammate-kb', at: '2026-11-20T23:08:00Z', body: "Not sure, I've asked the customer.", url: 'u4' });
  await syncQuestionThreads(store, gh, () => T, { me: ME });
  await syncQuestionThreads(store, gh, () => T, { me: ME });
  let q = store.state.questions['TB-1'];
  assert.equal(q.status, 'open', 'a reply is not an answer');
  assert.deepEqual(q.replies.map(r => r.by), ['teammate-kb'], 'bots, codex and Alex are not relayed; each reply once');
  const [m] = messagesTo(store, 'local-head');
  assert.match(m.payload?.text || m.text, /teammate-kb replied to TB-1[\s\S]*asked the customer[\s\S]*Judge it/);
  gh.comments.push({ by: 'teammate-kb', at: '2026-11-21T09:00:00Z', body: 'Customer says drop it: b', url: 'u5' });
  await syncQuestionThreads(store, gh, () => T, { me: ME });
  q = store.state.questions['TB-1'];
  assert.equal(q.replies.length, 2);
  assert.equal(messagesTo(store, 'local-head').length, 2, 'the later reply is sent too');
});

test('decision routing relays PR-discussion and Teamwork replies, skipping Alex, bots and Teamwork Sync', async () => {
  const { store, gh, tw } = routed(), at = () => '2026-11-20T23:05:01.000Z';
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined, audience: 'dev' } }, { now: T, by: 'sup: stream-1' });
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined, work: 'W-2', audience: 'product' } }, { now: T, by: 'sup: stream-1' });
  await syncQuestionRoutes(store, { gh, tw }, at, { me: ME, enabled: true });
  gh.discussion.push({ id: 'IC_0', by: 'codecov[bot]', at: '2026-11-20T23:06:00Z', body: 'a', url: 'c1' }, { id: 'IC_2', by: ME, at: '2026-11-20T23:06:10Z', body: 'a', url: 'c2' }, { id: 'IC_3', by: 'teammate-kb', at: '2026-11-20T23:07:00Z', body: 'a) keep it', url: 'c3' });
  tw.list.push({ id: 'tw-comment-1', by: 9, at: '2026-11-20T23:06:00Z', body: '**alex-gh** opened https://github.com/acme-org/app/pull/8635', sync: true }, { id: 'tw-comment-2', by: 7, at: '2026-11-20T23:06:30Z', body: 'b' }, { id: 'tw-comment-3', by: 12, at: '2026-11-20T23:08:00Z', body: 'B, product agrees' });
  await syncQuestionRoutes(store, { gh, tw }, at, { me: ME });
  const [dev, product] = [store.state.questions['TB-1'], store.state.questions['TB-2']];
  assert.deepEqual([dev.status, dev.replies.map(r => r.id)], ['open', ['IC_3']]);
  assert.deepEqual([product.status, product.replies.map(r => r.by)], ['open', ['Teamwork user 12']]);
  assert.equal(messagesTo(store, 'local-head').length, 2);
});

test('a reply to a factory question is never PR feedback, whether the poll saw it before or after the relay', async () => {
  const { store, gh, tw } = routed(), at = () => '2026-11-20T23:05:01.000Z';
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined, audience: 'dev' } }, { now: T, by: 'sup: stream-1' });
  await syncQuestionRoutes(store, { gh, tw }, at, { me: ME, enabled: true });
  store.append({ kind: 'observe_health', target: 'W-1', payload: { head: 'aaaaaaa1', comments: [{ id: 'IC_1', by: 'teammate-kb', url: 'c1' }] } }, { now: '2026-11-20T23:06:30Z', by: 'github' });
  const raised = store.state.work['W-1'].findings.find(f => f.source?.ids?.includes('IC_1'));
  assert.equal(raised.status, 'open');
  gh.discussion.push({ id: 'IC_1', by: 'teammate-kb', at: '2026-11-20T23:06:00Z', body: 'b', url: 'c1' }, { id: 'IC_9', by: 'teammate-kb', at: '2026-11-20T23:07:00Z', body: 'and one more thing', url: 'c9' });
  await syncQuestionRoutes(store, { gh, tw }, at, { me: ME });
  assert.equal(store.state.work['W-1'].findings.find(f => f.id === raised.id).status, 'resolved', 'seen first: settled');
  store.append({ kind: 'observe_health', target: 'W-1', payload: { head: 'aaaaaaa1', comments: [{ id: 'IC_9', by: 'teammate-kb', url: 'c9' }] } }, { now: '2026-11-20T23:08:00Z', by: 'github' });
  assert.deepEqual(store.state.work['W-1'].findings.filter(f => f.status === 'open' && f.source?.ids?.includes('IC_9')), [], 'relayed first: never raised');
});

test('the away report lists what was asked, the replies, the answer and what the record did after', async () => {
  const { store, gh, tw } = routed(), at = () => '2026-11-21T01:00:00.000Z';
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined, audience: 'dev' } }, { now: T, by: 'sup: stream-1' });
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined, work: 'W-2', audience: 'product', title: 'Nobody answered this' } }, { now: T, by: 'sup: stream-1' });
  await syncQuestionRoutes(store, { gh, tw }, at, { me: ME, enabled: true });
  gh.discussion.push({ id: 'IC_1', by: 'teammate-kb', at: '2026-11-21T02:00:00Z', body: 'b) drop it', url: 'c1' });
  await syncQuestionRoutes(store, { gh, tw }, () => '2026-11-21T02:01:00.000Z', { me: ME });
  store.append({ kind: 'answer', target: 'TB-1', payload: { choice: 'b', note: 'teammate-kb on the PR discussion: b) drop it' } }, { now: '2026-11-21T02:05:00.000Z', by: 'local-head' });
  store.append({ kind: 'event', target: 'W-1', payload: { type: 'note', text: 'Dropped the column per TB-1' } }, { now: '2026-11-21T03:00:00.000Z', by: 'sup: stream-1' });
  const md = awayReport(store.state, { since: '2026-11-21' });
  assert.match(md, /Asked off the dashboard: 2\. Got a reply: 1\. Answered: 1\. Still open: 1\./);
  assert.match(md, /### TB-1[\s\S]*teammate-kb: b\) drop it[\s\S]*Answered by local-head[\s\S]*option b[\s\S]*Dropped the column per TB-1/);
  assert.match(md, /Still open[\s\S]*### TB-2[\s\S]*Teamwork task 41323957[\s\S]*Replies: none/);
  assert.doesNotMatch(awayReport(store.state, { since: '2026-11-22' }), /TB-1/);
});
