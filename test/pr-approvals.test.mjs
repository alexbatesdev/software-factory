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
