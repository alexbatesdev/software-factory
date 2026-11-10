import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';

const S1 = 'sup: stream-1', T = '2026-11-09T20:00:00.000Z';
const config = { roles: { 'board lead': 'board-lead' }, routing: { supervisors: { [S1]: {} } } };

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

test("a record can't be marked ready into New PRs without its breakdown, and the panel shows it", async () => {
  const store = openStore(':memory:', { supervisors: [S1] }), c = { now: T, by: 'test' };
  store.append({ kind: 'create', payload: { title: 'Unasked fix', kind: 'build', source: { type: 'manual' } } }, c);
  const cfg = { ...config, roles: { 'board lead': 'board-lead' } };
  const server = http.createServer(createApi({ store, config: cfg, now: () => T }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const triage = async args => { const r = await fetch(`${base}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory': '1', 'x-seat': 'board lead' }, body: JSON.stringify({ action: 'triage', args: { work: 'W-1', bucket: 'ready', note: 'rule and evidence', ...args } }) }); return [r.status, await r.json()]; };
  try {
    const [code, body] = await triage({});
    assert.equal(code, 409); assert.match(body.error, /proposal/);
    const proposal = { prompted: 'p', addresses: 'a', whyThisFix: 'w', since: 's', customerImpact: 'none' };
    assert.equal((await triage({ proposal }))[0], 200);
    const b = await (await fetch(`${base}/api/board`)).json();
    assert.deepEqual(b.newPrs[0].proposal, { ...proposal, by: 'board lead', at: T });
  } finally { server.close(); }
});

test("a fix found while investigating a support task is part of it: no New-PR approval, assignable, dispatched (Alex, 11-09, W-329: W-314 from W-301)", async () => {
  const f = await serve();
  try {
    const ctx = { now: T, by: 'test' };
    const sup = f.store.append({ kind: 'create', payload: { title: 'Carrix | INVESTIGATE', kind: 'build', source: { type: 'teamwork', key: 'tw-1' }, stream: S1 } }, ctx).id;
    f.store.state.work[sup].support = true;
    const fix = f.store.append({ kind: 'create', payload: { title: 'Terminating a worker leaves them seated', kind: 'build', source: { type: 'manual' }, proposedFrom: sup, stream: S1 } }, ctx).id;
    f.store.append({ kind: 'event', target: fix, payload: { type: 'transition', to: 'ready' } }, ctx);
    const b = await f.board();
    assert.ok(!b.newPrs.some(p => p.id === fix), 'not in New PRs');
    assert.equal(b.cards.find(c => c.id === fix).approval, null, 'no approval note on its card');
    assert.ok(b.newPrs.some(p => p.id === 'W-1'), 'genuinely extra work still waits');
    const [, body] = await f.post('/api/actions', { action: 'assign', args: { work: fix, assignmentId: 'R1', kind: 'implementation', status: 'started', owner: S1 } }, S1);
    assert.doesNotMatch(body.error || '', /Alex's go|new PR/, 'the new-PR gate does not refuse it');
  } finally { f.close(); }
});

test("work that carries out Alex's own answer was asked for: no New-PR approval; triage carriesOut links an answer filed on another record (W-333)", async () => {
  const f = await serve();
  try {
    f.store.state.questions['TB-176'] = { status: 'answered', work: 'W-1', title: 'Which check?' };
    f.store.state.questions['TB-189'] = { status: 'answered', work: 'W-9', title: 'Lock state?' };
    f.store.state.questions['TB-190'] = { status: 'open', work: 'W-9', title: 'Still open' };
    assert.deepEqual((await f.board()).newPrs.map(p => p.id), ['W-2'], 'W-1 carries out TB-176, answered on it');
    const triage = args => f.post('/api/actions', { action: 'triage', args: { work: 'W-2', bucket: 'ready', note: 'n', ...args } }, 'board lead');
    assert.equal((await triage({ carriesOut: 'TB-190' }))[0], 409, 'only an answered question counts');
    assert.equal((await triage({ carriesOut: 'TB-189' }))[0], 200);
    assert.deepEqual((await f.board()).newPrs.map(p => p.id), [], 'W-2 carries out TB-189');
  } finally { f.close(); }
});
