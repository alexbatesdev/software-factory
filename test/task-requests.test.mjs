import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { openStore } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';

// Alex, 11-10 (W-382): a new Teamwork task is something he is told about first, like thread resolves and new PRs.
const SUP = 'sup: stream-1', T = '2026-11-10T23:30:00.000Z';
const DEV = 'triage board worker';
const config = { roles: { [DEV]: 'board-developer' }, routing: { supervisors: { [SUP]: {} } } };
const proposal = { work: 'W-1', name: 'Follow-up: guard the export modal', description: 'Found while fixing #8640.', tasklistId: 123, assigneeUserId: 9, why: 'Out of scope for W-1; needs its own task' };

async function serve(tw) {
  const store = openStore(':memory:', { supervisors: [SUP] });
  store.append({ kind: 'create', payload: { title: 'Export modal', stream: SUP } }, { now: T, by: 'test' });
  const server = http.createServer(createApi({ store, config, tw, now: () => T }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, seat) => { const r = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory': '1', ...(seat ? { 'x-seat': seat } : {}) }, body: JSON.stringify(body) }); return [r.status, await r.json()]; };
  return { store, act: (action, args, seat = DEV) => post('/api/actions', { action, args }, seat), decide: body => post('/api/task-requests', body), board: async () => (await fetch(`${base}/api/board`)).json(), close: () => server.close() };
}

test('a seat proposes a Teamwork task with what create_task needs; it waits on the dashboard, not as a question', async () => {
  const f = await serve(null);
  try {
    assert.equal((await f.act('propose_task', proposal))[0], 200);
    assert.equal((await f.act('propose_task', { ...proposal, name: 'x', tasklistId: undefined }))[0], 400, 'needs a tasklist or a parent task');
    assert.equal((await f.act('propose_task', { ...proposal, name: 'y', parentTaskId: 5 }))[0], 400, 'not both');
    assert.equal((await f.act('propose_task', { ...proposal, why: '' }))[0], 400);
    assert.equal((await f.act('propose_task', proposal))[0], 400, 'the same task proposed twice');
    const b = await f.board();
    assert.deepEqual(b.taskRequests.map(t => [t.id, t.work, t.name, t.status]), [['NT-1', 'W-1', proposal.name, 'requested']]);
    assert.equal(b.questions.length, 0);
  } finally { f.close(); }
});

test("Alex's Approve creates the task through teamwork-mini, reads it back, and links it on the record; Decline records why", async () => {
  const calls = [];
  const tw = { createTask: async input => { calls.push(input); return { id: 777, url: 'https://x.teamwork.com/app/tasks/777' }; }, getTask: async id => ({ id, name: proposal.name }) };
  const f = await serve(tw);
  try {
    await f.act('propose_task', proposal);
    await f.act('propose_task', { ...proposal, name: 'Not needed' });
    const [code, body] = await f.decide({ ids: ['NT-1'], decision: 'approve' });
    assert.equal(code, 200, JSON.stringify(body));
    assert.deepEqual(calls, [{ tasklistId: 123, name: proposal.name, description: proposal.description, assigneeUserId: 9 }]);
    const t = f.store.state.taskRequests['NT-1'];
    assert.deepEqual([t.status, t.taskId, t.url, t.verified, t.approvedBy], ['created', 777, 'https://x.teamwork.com/app/tasks/777', true, 'Alex (dashboard)']);
    assert.match(f.store.state.work['W-1'].updates.at(-1).text, /tasks\/777.*NT-1/);
    assert.equal((await f.decide({ ids: ['NT-1'], decision: 'approve' }))[1].results[0].error !== undefined, true, 'never created twice');
    assert.equal(calls.length, 1);
    await f.decide({ ids: ['NT-2'], decision: 'decline', note: 'covered by W-9' });
    assert.deepEqual([f.store.state.taskRequests['NT-2'].status, f.store.state.taskRequests['NT-2'].detail], ['declined', 'covered by W-9']);
    assert.deepEqual((await f.board()).taskRequests.map(x => x.id), [], 'decided requests leave the panel');
  } finally { f.close(); }
});

test('a failed create shows on the panel with the reason and can be retried; no create_task yet means a clear failure', async () => {
  const f = await serve({ createTask: async () => { throw new Error('teamwork-mini has no createTask yet'); }, getTask: async () => null });
  try {
    await f.act('propose_task', proposal);
    await f.decide({ ids: ['NT-1'], decision: 'approve' });
    const [t] = (await f.board()).taskRequests;
    assert.deepEqual([t.status, /no createTask/.test(t.detail)], ['failed', true]);
  } finally { f.close(); }
});

test('only the factory creates Teamwork tasks: no seat holds a create action, and the page lists proposals with Approve and Decline', async () => {
  const { ROLES } = await import('../core/capabilities.mjs');
  for (const [role, actions] of Object.entries(ROLES)) assert.ok(!actions.some(a => /create_task/.test(a)), role);
  const page = readFileSync(new URL('../views/index.html', import.meta.url), 'utf8');
  assert.match(page, /New Teamwork tasks/);
  assert.match(page, /\/api\/task-requests/);
});

test('a retry never makes a second task: it finds one an earlier attempt made, refuses when Teamwork cannot be checked, and one request names each proposal once (review of b774b4a)', async () => {
  let made = 0, existing = null, findFails = false;
  const tw = { createTask: async () => { made++; if (made === 1) throw new Error('timed out'); return { id: 900 + made, url: `u/${900 + made}` }; },
    getTask: async id => ({ id, name: proposal.name }), findTask: async () => { if (findFails) throw new Error('search down'); return existing; } };
  const f = await serve(tw);
  try {
    await f.act('propose_task', proposal);
    await f.decide({ ids: ['NT-1', 'NT-1'], decision: 'approve' });
    assert.equal(made, 1, 'the same id twice in one request is one attempt');
    assert.equal(f.store.state.taskRequests['NT-1'].status, 'failed');
    findFails = true;
    await f.decide({ ids: ['NT-1'], decision: 'approve' });
    assert.deepEqual([made, f.store.state.taskRequests['NT-1'].status], [1, 'failed'], 'no check, no retry');
    findFails = false; existing = { id: 555, url: 'u/555' };
    await f.decide({ ids: ['NT-1'], decision: 'approve' });
    const t = f.store.state.taskRequests['NT-1'];
    assert.deepEqual([made, t.status, t.taskId], [1, 'created', 555], 'the timed-out attempt had created it');
  } finally { f.close(); }
});

test('a proposal stuck mid-create (the server stopped) can be retried after two minutes, through the same existing-task check', async () => {
  let made = 0;
  const f = await serve({ createTask: async () => ({ id: 1000 + ++made, url: 'u' }), getTask: async () => null, findTask: async () => null });
  try {
    await f.act('propose_task', proposal);
    f.store.append({ kind: 'task_decide', target: 'NT-1', payload: { decision: 'approve' } }, { now: '2026-11-10T23:20:00.000Z', by: 'Alex (dashboard)' });
    assert.equal((await f.board()).taskRequests[0].stuck, true);
    await f.decide({ ids: ['NT-1'], decision: 'approve' });
    assert.deepEqual([made, f.store.state.taskRequests['NT-1'].status], [1, 'created']);
  } finally { f.close(); }
});

test('a task proposal is a receipt for work, never a reason to stop it: nobody parks or holds a record on an NT-n (Alex, 11-11)', async () => {
  const f = await serve(null);
  try {
    await f.act('propose_task', proposal);
    const [code, body] = await f.act('progress', { work: 'W-1', waitingOn: 'NT-1', actor: 'alex', text: 'waiting for the task' });
    assert.equal(code, 400, JSON.stringify(body));
    assert.match(body.error, /receipt/);
    assert.equal((await f.act('progress', { work: 'W-1', waitingOn: 'Teamwork task NT-1 approval', actor: 'alex' }))[0], 400);
    const tool = readFileSync(new URL('../mcp/server.mjs', import.meta.url), 'utf8');
    assert.match(tool, /propose_task: \['[^']*keep working/);
  } finally { f.close(); }
});
