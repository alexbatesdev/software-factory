import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { syncQuestionThreads, questionBody, pickOption } from '../effects/question-threads.mjs';

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

test('the first teammate reply after the post answers it; Alex, bots and codex never do', async () => {
  const store = setup(), gh = fakeGh();
  store.append({ kind: 'ask', payload: ask }, { now: T, by: 'sup: stream-1' });
  await syncQuestionThreads(store, gh, () => '2026-11-20T23:05:01.000Z', { me: ME, enabled: true });
  gh.comments.push({ by: 'chatgpt-codex-connector', at: '2026-11-20T23:06:00Z', body: 'a', url: 'u1' },
    { by: 'dependabot[bot]', at: '2026-11-20T23:06:30Z', body: 'a', url: 'u2' }, { by: ME, at: '2026-11-20T23:07:00Z', body: 'a', url: 'u3' });
  await syncQuestionThreads(store, gh, () => T, { me: ME, enabled: false });
  assert.equal(store.state.questions['TB-1'].status, 'open');
  gh.comments.push({ by: 'teammate-kb', at: '2026-11-20T23:08:00Z', body: 'Option B. Nobody reads that column.', url: `${PR}#discussion_r3` });
  await syncQuestionThreads(store, gh, () => T, { me: ME, enabled: false });
  const q = store.state.questions['TB-1'];
  assert.equal(q.status, 'answered', 'read even with posting turned off');
  assert.equal(q.answer.choice, 'b');
  assert.equal(q.answer.by, 'teammate-kb (PR thread)');
  assert.match(q.answer.note, /Nobody reads that column[\s\S]*discussion_r3/);
});

test('a question with no thread, or on a merged PR, is left alone', async () => {
  const store = setup(), gh = fakeGh();
  store.append({ kind: 'ask', payload: { ...ask, threadId: undefined } }, { now: T, by: 'sup: stream-1' });
  store.append({ kind: 'ask', payload: { ...ask, title: 'second' } }, { now: T, by: 'sup: stream-1' });
  await syncQuestionThreads(store, gh, () => T, { me: ME, enabled: true, prState: () => 'MERGED' });
  assert.equal(gh.posts.length, 0);
});

test('a reply picks an option by its first word only', () => {
  const o = ask.options;
  assert.equal(pickOption('b) drop it', o), 'b');
  assert.equal(pickOption('**A**', o), 'a');
  assert.equal(pickOption('Option a, please', o), 'a');
  assert.equal(pickOption('about that column...', o), null);
  assert.equal(pickOption('I think b', o), null);
});
