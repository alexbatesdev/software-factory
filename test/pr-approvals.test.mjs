import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';

const S1 = 'sup: stream-1', T = '2026-11-09T20:00:00.000Z';
const config = { roles: {}, routing: { supervisors: { [S1]: {} } } };

async function serve() {
  const store = openStore(':memory:', { supervisors: [S1] });
  const ctx = { now: T, by: 'test' };
  for (const title of ['Another create action takes over a company', 'A second unasked fix']) {
    const id = store.append({ kind: 'create', payload: { title, kind: 'build', source: { type: 'manual' }, proposedFrom: 'W-9', stream: S1 } }, ctx).id;
    store.append({ kind: 'event', target: id, payload: { type: 'transition', to: 'ready' } }, ctx);
  }
  const server = http.createServer(createApi({ store, config, now: () => T }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, seat) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory': '1', ...(seat ? { 'x-seat': seat } : {}) }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
  return { store, post, board: async () => (await fetch(`${base}/api/board`)).json(), close: () => server.close() };
}

test('a new PR nobody asked for is Alex\'s click on the dashboard: listed, unassignable until approved, declined by withdrawing it (Alex, 11-09)', async () => {
  const f = await serve();
  try {
    assert.deepEqual((await f.board()).newPrs.map(p => p.id), ['W-1', 'W-2']);
    assert.equal(Object.keys(f.store.state.questions).length, 0, 'not a TB question');
    const [code, body] = await f.post('/api/actions', { action: 'assign', args: { work: 'W-1', assignmentId: 'R1', kind: 'implementation', status: 'started', owner: S1 } }, S1);
    assert.equal(code, 409); assert.match(body.error, /Alex's go/);
    assert.equal((await f.post('/api/pr-approvals', { ids: ['W-1'], decision: 'approve' }))[0], 200);
    assert.equal(f.store.state.work['W-1'].prApproval.by, 'Alex (dashboard)');
    await f.post('/api/pr-approvals', { ids: ['W-2'], decision: 'decline' });
    assert.equal(f.store.state.work['W-2'].phase, 'cancelled');
    assert.deepEqual((await f.board()).newPrs, []);
  } finally { f.close(); }
});

test('support work glows everywhere it shows: its card, questions, threads and new PRs, and records filed from it inherit it', async () => {
  const { supportOf } = await import('../core/store.mjs');
  const store = openStore(':memory:', { supervisors: [S1] }), c = { now: T, by: 'test' };
  store.append({ kind: 'observe_source', payload: { id: 'tw-5', kind: 'task', ref: '5', title: 'Carrix | INVESTIGATE', url: 'u', description: 'd', support: true } }, c);
  store.append({ kind: 'event', target: 'W-1', payload: { type: 'discovery', text: 'A find while investigating', objective: 'x' } }, c);
  const kid = Object.values(store.state.work).find(w => w.proposedFrom === 'W-1');
  assert.deepEqual([supportOf(store.state, 'W-1'), supportOf(store.state, kid.id)], [true, true]);
  store.append({ kind: 'create', payload: { title: 'Ordinary' } }, c);
  assert.equal(supportOf(store.state, 'W-3'), false);
  store.append({ kind: 'ask', payload: { title: 'Which customer?', options: [], work: 'W-1', wwbd: 'none' } }, { ...c, by: S1 });
  const server = http.createServer(createApi({ store, config, now: () => T }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  try {
    const b = await (await fetch(`http://127.0.0.1:${server.address().port}/api/board`)).json();
    assert.equal(b.cards.find(x => x.id === 'W-1').support, true);
    assert.equal(b.cards.find(x => x.id === 'W-3').support, false);
    assert.equal(b.questions[0].support, true);
  } finally { server.close(); }
});
