import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';
import { syncResolvedThreads } from '../effects/threads.mjs';
import { readFileSync } from 'node:fs';

const S1 = 'triage board worker', PR = 'https://github.com/acme-org/app/pull/8635', T = '2026-11-09T18:00:00.000Z';
const config = { roles: { 'triage board worker': 'factory-developer' }, routing: { supervisors: {} } };
const request = { work: 'W-1', threadId: 'PRRT_abc', url: `${PR}#discussion_r1`, reviewer: 'reviewer-jm', ask: 'Guard the deleted pay type', resolution: 'Fixed at 6377559 with a spec pinning the deleted pay type' };

async function serve(gh) {
  const store = openStore(':memory:', { supervisors: [S1] });
  const ctx = { now: T, by: 'test' };
  store.append({ kind: 'create', payload: { title: 'PR feedback', links: { pr: PR }, stream: S1 } }, ctx);
  store.append({ kind: 'observe_head', target: 'W-1', payload: { sha: 'aaaaaaa1', via: 'github', isDraft: false } }, ctx);
  store.append({ kind: 'observe_health', target: 'W-1', payload: { head: 'aaaaaaa1', threads: [{ id: 'PRRT_abc', by: 'reviewer-jm', url: request.url }] } }, ctx);
  const server = http.createServer(createApi({ store, config, gh, now: () => T }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, seat = S1) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory': '1', 'x-seat': seat }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
  return { store, act: (action, args, seat) => post('/api/actions', { action, args }, seat), resolve: ids => post('/api/threads/resolve', { ids }, 'Alex (dashboard)'), board: async () => (await fetch(`${base}/api/board`)).json(), comments: async id => (await fetch(`${base}/api/threads/${id}/comments`)).json(), close: () => server.close() };
}

test('a resolve request carries what GitHub needs, and only for a thread the poll reported on that record', async () => {
  const f = await serve();
  try {
    assert.match((await f.act('resolve_thread', { ...request, threadId: 'PRRT_other' }))[1].error, /never reported/);
    assert.match((await f.act('resolve_thread', { ...request, resolution: '' }))[1].error, /resolution/);
    assert.equal((await f.act('resolve_thread', request))[0], 200);
    assert.match((await f.act('resolve_thread', request))[1].error, /already/);
    const [rt] = Object.values(f.store.state.threads);
    assert.deepEqual([rt.status, rt.pr, rt.threadId, rt.from], ['requested', PR, 'PRRT_abc', S1]);
    assert.equal(Object.keys(f.store.state.questions).length, 0, 'not a TB question');
    assert.equal((await f.board()).threads.length, 1, 'the dashboard lists it');
  } finally { f.close(); }
});

test('a "resolve this thread?" question is refused and pointed at resolve_thread', async () => {
  const f = await serve();
  try {
    const [code, body] = await f.act('ask', { title: "#8638: resolve codex's thread on passing the requisition company explicitly?", promptedBy: 'x' });
    assert.equal(code, 409);
    assert.match(body.error, /resolve_thread/);
  } finally { f.close(); }
});

test('Resolve on the dashboard resolves the thread on GitHub and records the readback, with no agent', async () => {
  let resolved = false;
  const gh = { thread: async id => (id === 'PRRT_abc' ? { pr: PR, isResolved: resolved } : null), resolveThread: async () => { resolved = true; } };
  const f = await serve(gh);
  try {
    await f.act('resolve_thread', request);
    const [code, body] = await f.resolve(['RT-1']);
    assert.equal(code, 200);
    assert.deepEqual(body.results.map(r => r.status), ['resolved']);
    assert.equal(f.store.state.threads['RT-1'].status, 'resolved');
    assert.equal(f.store.state.threads['RT-1'].approvedBy, 'Alex (dashboard)');
  } finally { f.close(); }
});

test('a thread on another PR fails without a write', async () => {
  let wrote = false;
  const gh = { thread: async () => ({ pr: 'https://github.com/acme-org/app/pull/1', isResolved: false }), resolveThread: async () => { wrote = true; } };
  const f = await serve(gh);
  try {
    await f.act('resolve_thread', request);
    const [, body] = await f.resolve(['RT-1']);
    assert.equal(body.results[0].status, 'failed');
    assert.match(f.store.state.threads['RT-1'].detail, /pull\/1/);
    assert.equal(wrote, false);
  } finally { f.close(); }
});

test('a factual PR-description fix is applied by the worker, never asked as a question', async () => {
  const f = await serve();
  try {
    for (const title of ['#8632: apply the 3 PR-body edits?', 'W-169: update the PR description to match 1ff0526?']) {
      const [code, body] = await f.act('ask', { title, promptedBy: 'x', wwbd: 'n/a' });
      assert.equal(code, 409, title);
      assert.match(body.error, /apply it yourself/);
    }
  } finally { f.close(); }
});

test('a request whose thread Alex resolved on GitHub himself closes as resolved on the next sync', async () => {
  let isResolved = false;
  const f = await serve({ thread: async () => ({ pr: PR, isResolved }) });
  try {
    await f.act('resolve_thread', request);
    await syncResolvedThreads(f.store, { threadFacts: async () => ({ isResolved }) }, () => T);
    assert.equal(f.store.state.threads['RT-1'].status, 'requested', 'still open on GitHub');
    isResolved = true;
    await syncResolvedThreads(f.store, { threadFacts: async () => ({ isResolved }) }, () => T);
    assert.deepEqual([f.store.state.threads['RT-1'].status, f.store.state.threads['RT-1'].detail], ['resolved', 'Resolved on GitHub directly.']);
  } finally { f.close(); }
});

test("a thread request's last five messages are read from GitHub on demand, only for a thread the board holds", async () => {
  const asked = [];
  const msgs = [{ by: 'reviewer-jm', at: T, body: 'What if the pay type is deleted?', url: `${PR}#discussion_r1` }];
  const f = await serve({ threadComments: async id => { asked.push(id); return msgs; } });
  try {
    await f.act('resolve_thread', request);
    const [rt] = Object.keys(f.store.state.threads);
    assert.deepEqual(await f.comments(rt), { comments: msgs.map(m => ({ ...m, mine: false })) });
    assert.deepEqual(asked, ['PRRT_abc'], 'asks GitHub for the thread the request names');
    assert.equal((await f.comments('RT-99')).error, 'There is no thread request RT-99.');
  } finally { f.close(); }
});

test("a codex thread we replied to resolves itself only with a fix commit that changes its file; a reply alone stays Alex's click (Alex, 11-20, replacing 11-11)", async () => {
  let resolved = false;
  const gh = { thread: async () => ({ pr: PR, isResolved: resolved }), resolveThread: async () => { resolved = true; }, reviews: async () => [],
    threadFacts: async () => ({ isResolved: resolved, first: 'chatgpt-codex-connector', path: 'app/a.rb', comments: [{ by: 'chatgpt-codex-connector', at: T, thumbsBy: [] }, { by: 'alexbatesdev', at: T, thumbsBy: [] }] }),
    fixFacts: async () => ({ onPr: true, files: ['app/a.rb'], index: 0, shas: ['6377559aa'] }) };
  const f = await serve(gh);
  try {
    await f.act('resolve_thread', request);
    await syncResolvedThreads(f.store, gh, () => T, { me: 'alexbatesdev' });
    assert.match(f.store.state.threads['RT-1'].checks.failed.join(), /no fix commit/);
    f.store.append({ kind: 'thread_op', target: 'RT-1', payload: { status: 'dismissed', detail: 'test' } }, { now: T, by: 'test' });
    f.store.append({ kind: 'observe_health', target: 'W-1', payload: { head: 'aaaaaaa1', threads: [{ id: 'PRRT_def', by: 'chatgpt-codex-connector', url: request.url }] } }, { now: T, by: 'test' });
    await f.act('resolve_thread', { ...request, threadId: 'PRRT_def', fixSha: '6377559' });
    await syncResolvedThreads(f.store, gh, () => T, { me: 'alexbatesdev' });
    const t = f.store.state.threads['RT-2'];
    assert.deepEqual([t.status, t.approvedBy, resolved], ['resolved', 'factory (auto: checks passed)', true]);
  } finally { f.close(); }
});

test("a thread's messages say which are ours, so the page can tell them apart", async () => {
  const gh = { thread: async () => ({ pr: PR, isResolved: false }), threadComments: async () => [{ by: 'chatgpt-codex-connector', body: 'P1' }, { by: 'alexbatesdev', body: 'Fixed' }] };
  const store = openStore(':memory:', { supervisors: [S1] });
  const ctx = { now: T, by: 'test' };
  store.append({ kind: 'create', payload: { title: 'x', links: { pr: PR }, stream: S1 } }, ctx);
  store.append({ kind: 'observe_head', target: 'W-1', payload: { sha: 'aaaaaaa1', via: 'github', isDraft: false } }, ctx);
  store.append({ kind: 'observe_health', target: 'W-1', payload: { head: 'aaaaaaa1', threads: [{ id: 'PRRT_abc', by: 'x', url: request.url }] } }, ctx);
  store.append({ kind: 'thread_request', payload: request }, ctx);
  const server = http.createServer(createApi({ store, config: { ...config, githubLogin: 'alexbatesdev' }, gh, now: () => T }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  try {
    const r = await (await fetch(`http://127.0.0.1:${server.address().port}/api/threads/RT-1/comments`)).json();
    assert.deepEqual(r.comments.map(c => c.mine), [false, true]);
    assert.match(readFileSync(new URL('../views/index.html', import.meta.url), 'utf8'), /\.msg\.mine/);
  } finally { server.close(); }
});

test('a resolve request on a PR that has merged or closed is dismissed: nothing is written to GitHub and it leaves the panel (Alex, 11-11)', async () => {
  let wrote = false;
  const gh = { thread: async () => ({ pr: PR, isResolved: false }), threadFacts: async () => ({ isResolved: false, first: 'reviewer-sam', comments: [{ by: 'alexbatesdev', at: T, thumbsBy: [] }] }), reviews: async () => [], resolveThread: async () => { wrote = true; } };
  const f = await serve(gh);
  try {
    await f.act('resolve_thread', request);
    await syncResolvedThreads(f.store, gh, () => T, { me: 'alexbatesdev', prState: () => 'OPEN' });
    assert.equal(f.store.state.threads['RT-1'].status, 'requested');
    await syncResolvedThreads(f.store, gh, () => T, { me: 'alexbatesdev', prState: u => u === PR ? 'MERGED' : null });
    const t = f.store.state.threads['RT-1'];
    assert.deepEqual([t.status, /merged/.test(t.detail), wrote], ['dismissed', true, false]);
    assert.deepEqual((await f.board()).threads, [], 'gone from Approvals');
  } finally { f.close(); }
});

// Alex, 11-20 (c): the factory resolves a thread once the checks pass; Alex's click stays the override.
test("a thread is ready only when its fix commit is on the PR and changes the thread's file, nobody spoke after us, and a person's thread has the asker's acceptance", async () => {
  const { threadGate } = await import('../core/threads.mjs');
  const me = 'alexbatesdev', jm = 'reviewer-jm', at = s => `2026-11-20T0${s}:00:00Z`;
  const facts = (over = {}) => ({ first: jm, path: 'app/a.rb', comments: [{ by: jm, at: at(1), thumbsBy: [] }, { by: me, at: at(2), thumbsBy: [] }], fix: { onPr: true, files: ['app/a.rb'], index: 3 }, approvals: [], ...over });
  const gate = (f, fixSha = 'abc1234') => threadGate({ me, fixSha }, f);
  assert.match(gate(facts()).failed.join(), /hasn't accepted/);
  assert.deepEqual(gate(facts({ comments: [{ by: jm, at: at(1), thumbsBy: [] }, { by: me, at: at(2), thumbsBy: [jm] }] })), { ready: true, failed: [] }, 'a 👍 from the asker on our reply');
  assert.equal(gate(facts({ approvals: [{ by: jm, state: 'APPROVED', at: at(3), index: 4 }] })).ready, true, 'an approval at a commit including the fix');
  assert.match(gate(facts({ approvals: [{ by: jm, state: 'APPROVED', at: at(3), index: 2 }] })).failed.join(), /hasn't accepted/, 'an approval before the fix');
  assert.match(gate(facts({ approvals: [{ by: jm, state: 'APPROVED', at: at(3), index: 4 }, { by: jm, state: 'CHANGES_REQUESTED', at: at(4), index: 4 }] })).failed.join(), /hasn't accepted/, 'only the latest review counts');
  assert.match(gate(facts({ comments: [{ by: jm, at: at(1), thumbsBy: [] }, { by: me, at: at(2), thumbsBy: [jm] }, { by: jm, at: at(3), thumbsBy: [] }] })).failed.join(), /replied after us/);
  assert.match(gate(facts({ fix: { onPr: false, files: [] } })).failed.join(), /isn't on the PR/);
  assert.match(gate(facts({ fix: { onPr: true, files: ['app/b.rb'], index: 3 } })).failed.join(), /doesn't change app\/a\.rb/);
  assert.match(gate(facts({ comments: [{ by: jm, at: at(1), thumbsBy: [] }] })).failed.join(), /haven't replied/);
  const codex = c => facts({ first: 'chatgpt-codex-connector', comments: [{ by: 'chatgpt-codex-connector', at: at(1), thumbsBy: [] }, { by: me, at: at(2), thumbsBy: [] }], ...c });
  assert.deepEqual(gate(codex()), { ready: true, failed: [] }, "a codex thread needs no acceptance: codex doesn't re-review after a push");
  assert.match(gate(codex(), null).failed.join(), /no fix commit/, 'a reply alone on a codex thread is Alex\'s click');
  assert.equal(gate(facts({ fix: null, approvals: [{ by: jm, state: 'APPROVED', at: at(3) }] }), null).ready, true, "a person's thread settled by explanation needs their approval after our reply");
});

test('the sync resolves a thread whose checks pass and shows the failed checks on one that waits (Alex, 11-20)', async () => {
  let resolved = false, thumbs = [];
  const gh = { thread: async () => ({ pr: PR, isResolved: resolved }), resolveThread: async () => { resolved = true; },
    threadFacts: async () => ({ isResolved: resolved, first: 'reviewer-jm', path: 'app/a.rb', comments: [{ by: 'reviewer-jm', at: T, thumbsBy: [] }, { by: 'alexbatesdev', at: T, thumbsBy: thumbs }] }),
    fixFacts: async (pr, sha) => ({ onPr: sha === '6377559', files: ['app/a.rb'], index: 1, shas: ['x', '6377559aa'] }), reviews: async () => [] };
  const f = await serve(gh);
  try {
    assert.equal((await f.act('resolve_thread', { ...request, fixSha: 'nothex' }))[0], 400);
    await f.act('resolve_thread', { ...request, fixSha: '6377559' });
    await syncResolvedThreads(f.store, gh, () => T, { me: 'alexbatesdev' });
    let t = f.store.state.threads['RT-1'];
    assert.equal(t.status, 'requested'); assert.match(t.checks.failed.join(), /hasn't accepted/);
    assert.match(JSON.stringify((await f.board()).threads[0].checks), /hasn't accepted/, 'the dashboard shows why it waits');
    thumbs = ['reviewer-jm'];
    await syncResolvedThreads(f.store, gh, () => T, { me: 'alexbatesdev' });
    t = f.store.state.threads['RT-1'];
    assert.deepEqual([t.status, t.approvedBy, resolved], ['resolved', 'factory (auto: checks passed)', true]);
  } finally { f.close(); }
});
