import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';

const S1 = 'triage board worker', PR = 'https://github.com/builtforteams/built-rails/pull/8635', T = '2026-11-09T18:00:00.000Z';
const config = { roles: { 'triage board worker': 'board-developer' }, routing: { supervisors: {} } };
const request = { work: 'W-1', threadId: 'PRRT_abc', url: `${PR}#discussion_r1`, reviewer: 'jmcdonald-ut', ask: 'Guard the deleted pay type', resolution: 'Fixed at 6377559 with a spec pinning the deleted pay type' };

async function serve(gh) {
  const store = openStore(':memory:', { supervisors: [S1] });
  const ctx = { now: T, by: 'test' };
  store.append({ kind: 'create', payload: { title: 'PR feedback', links: { pr: PR }, stream: S1 } }, ctx);
  store.append({ kind: 'observe_head', target: 'W-1', payload: { sha: 'aaaaaaa1', via: 'github', isDraft: false } }, ctx);
  store.append({ kind: 'observe_health', target: 'W-1', payload: { head: 'aaaaaaa1', threads: [{ id: 'PRRT_abc', by: 'jmcdonald-ut', url: request.url }] } }, ctx);
  const server = http.createServer(createApi({ store, config, gh, now: () => T }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, seat = S1) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory': '1', 'x-seat': seat }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
  return { store, act: (action, args, seat) => post('/api/actions', { action, args }, seat), resolve: ids => post('/api/threads/resolve', { ids }, 'Alex (dashboard)'), board: async () => (await fetch(`${base}/api/board`)).json(), close: () => server.close() };
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
  const gh = { thread: async () => ({ pr: 'https://github.com/builtforteams/built-rails/pull/1', isResolved: false }), resolveThread: async () => { wrote = true; } };
  const f = await serve(gh);
  try {
    await f.act('resolve_thread', request);
    const [, body] = await f.resolve(['RT-1']);
    assert.equal(body.results[0].status, 'failed');
    assert.match(f.store.state.threads['RT-1'].detail, /pull\/1/);
    assert.equal(wrote, false);
  } finally { f.close(); }
});
