import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openStore } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';

const S1 = 'sup: stream-1';
const config = { roles: { 'local-head': 'local-head', 'questions router': 'questions-router', 'board lead': 'board-lead', 'triage board worker': 'board-developer' }, routing: { supervisors: { [S1]: {} } } };
async function serve() {
  const store = openStore(':memory:', { supervisors: [S1] });
  const server = http.createServer(createApi({ store, config, now: () => '2026-10-30T20:00:00.000Z' }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const act = async (seat, action, args, headers = { 'x-factory': '1' }) => {
    const r = await fetch(`${base}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-seat': seat, ...headers }, body: JSON.stringify({ action, args }) });
    return [r.status, await r.json()];
  };
  const inbox = async seat => (await (await fetch(`${base}/api/inbox`, { headers: { 'x-seat': seat } })).json()).messages;
  return { store, act, inbox, close: () => server.close() };
}

test('a seat may only take its role\'s actions, and unknown callers none', async () => {
  const f = await serve();
  try {
    assert.equal((await f.act('local-head', 'create', { title: 'Fix it' }))[0], 200);
    assert.match((await f.act('questions router', 'done', { work: 'W-1', head: 'abc1234' }))[1].error, /may not done/);
    assert.match((await f.act('stranger', 'create', { title: 'x' }))[1].error, /not a factory seat/);
    assert.equal((await f.act('local-head', 'create', { title: 'x' }, {}))[0], 403, 'no x-factory header, no write');
    assert.equal(Object.keys(f.store.state.work).length, 1);
  } finally { f.close(); }
});

test('the router sends an answer on and sets the owner; the owner finds it in its inbox and acks it', async () => {
  const f = await serve();
  try {
    await f.act('local-head', 'create', { title: 'Unowned work' });
    await f.act(S1, 'ask', { title: 'Which way?', options: [{ key: 'a', text: 'this' }], work: 'W-1' });
    assert.equal((await f.act('local-head', 'answer', { id: 'TB-1', choice: 'a' }))[0], 200);
    const [code] = await f.act('questions router', 'route', { id: 'TB-1', to: S1, setOwner: true, note: 'stream 1 asked' });
    assert.equal(code, 200);
    assert.deepEqual([f.store.state.work['W-1'].owner, f.store.state.work['W-1'].stream], [S1, S1]);
    assert.match((await f.act('questions router', 'message', { to: S1, text: 'x' }))[1].error, /may not message/);
    await f.act('triage board worker', 'message', { to: S1, work: 'W-1', text: 'TB-1 is yours' });
    const [m] = await f.inbox(S1);
    assert.equal(m.text, 'TB-1 is yours');
    assert.match((await f.act('local-head', 'ack', { ref: m.id }))[1].error, /only that seat acks it/);
    assert.equal((await f.act(S1, 'ack', { ref: m.id }))[0], 200);
    assert.deepEqual(await f.inbox(S1), []);
  } finally { f.close(); }
});

test("acking a request also closes the stream's inbox message about it", async () => {
  const f = await serve();
  try {
    await f.act('local-head', 'create', { title: 'Queue me' });
    f.store.appendAll([{ kind: 'update', target: 'W-1', payload: { owner: S1, stream: S1 } }, { kind: 'event', target: 'W-1', payload: { type: 'transition', to: 'ready' } }, { kind: 'event', target: 'W-1', payload: { type: 'transition', to: 'queued' } }], { now: 'n', by: 'test' });
    const r = f.store.state.work['W-1'].requests.at(-1);
    f.store.append({ kind: 'message', payload: { to: S1, work: 'W-1', about: { requests: `W-1/${r.id}` }, text: 'go' } }, { now: 'n', by: 'board' });
    assert.equal((await f.inbox(S1)).length, 1);
    assert.equal((await f.act(S1, 'ack', { ref: `W-1/${r.id}`, outcome: 'received' }))[0], 200);
    assert.deepEqual(await f.inbox(S1), []);
    assert.equal(f.store.state.work['W-1'].requests.at(-1).ack.outcome, 'received');
  } finally { f.close(); }
});

async function serveWith(opts) {
  const store = openStore(':memory:', { supervisors: [S1] });
  const server = http.createServer(createApi({ store, config, now: () => '2026-10-30T20:00:00.000Z', ...opts }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const act = async (seat, action, args) => { const r = await fetch(`${base}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-seat': seat, 'x-factory': '1' }, body: JSON.stringify({ action, args }) }); return [r.status, await r.json()]; };
  return { store, act, close: () => server.close() };
}
const started = f => f.store.appendAll([
  { kind: 'create', payload: { title: 'Build it', links: { pr: PRURL } } }, { kind: 'update', target: 'W-1', payload: { owner: S1, stream: S1 } },
  ...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
  { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'started', owner: S1, evidence: 'brief' } },
], { now: 'n', by: 'test' });
const PRURL = 'https://github.com/builtforteams/built-rails/pull/1';

test('done is checked against a fresh GitHub read of the PR head', async () => {
  const f = await serveWith({ readPr: async url => ({ url, head: 'bbb2222', state: 'OPEN', isDraft: true }) });
  try {
    started(f);
    const a = f.store.state.work['W-1'].assignments.find(x => x.status === 'started');
    const [code, body] = await f.act(S1, 'done', { work: 'W-1', assignmentId: a.id, expectedVersion: a.version, head: 'aaa1111' });
    assert.equal(code, 400); assert.match(body.error, /GitHub shows bbb2222/);
    assert.equal((await f.act(S1, 'done', { work: 'W-1', assignmentId: a.id, expectedVersion: a.version, head: 'bbb2222' }))[0], 200);
  } finally { f.close(); }
});

test('create records the calling seat as the source and never a poller source or a later phase', async () => {
  const f = await serveWith({});
  try {
    await f.act('local-head', 'create', { title: 'x', source: { type: 'teamwork', key: 'tw-1' }, phase: 'implementation' });
    const w = f.store.state.work['W-1'];
    assert.deepEqual([w.source, w.phase], [{ type: 'agent', by: 'local-head' }, 'intake']);
    await f.act('local-head', 'create', { title: 'y', phase: 'proposed' });
    assert.equal(f.store.state.work['W-2'].phase, 'proposed');
  } finally { f.close(); }
});

test('a retried action with the same eventId is applied once', async () => {
  const f = await serveWith({});
  try {
    await f.act('local-head', 'create', { title: 'x', eventId: 'e-1' });
    await f.act('local-head', 'create', { title: 'x', eventId: 'e-1' });
    assert.equal(Object.keys(f.store.state.work).length, 1);
  } finally { f.close(); }
});

test('an approval wait is checked against a fresh GitHub read: draft or moved PRs are refused', async () => {
  let remote = { url: PRURL, head: 'ccc3333', state: 'OPEN', isDraft: true };
  const f = await serveWith({ readPr: async () => remote });
  try {
    f.store.appendAll([{ kind: 'create', payload: { title: 'Ready PR', links: { pr: PRURL } } }, { kind: 'event', target: 'W-1', payload: { type: 'head', sha: 'ccc3333' } }], { now: 'n', by: 'test' });
    const waiver = { by: 'Alex', reason: 'already marked ready', authorization: 'standing waiver 2026-10-27' };
    const wait = () => f.act(S1, 'await_approval', { work: 'W-1', head: 'ccc3333', evidence: 'gh pr view', waiver });
    assert.match((await wait())[1].error, /open and ready/);
    remote = { ...remote, isDraft: false, head: 'ddd4444' };
    assert.match((await wait())[1].error, /current GitHub commit/);
    remote = { ...remote, head: 'ccc3333' };
    assert.equal((await wait())[0], 200);
    assert.equal(f.store.state.work['W-1'].phase, 'awaiting_human_approval');
    assert.match((await f.act('local-head', 'await_approval', { work: 'W-1' }))[1].error, /may not await_approval/);
  } finally { f.close(); }
});

test('create cannot set correlation or ownership fields', async () => {
  const f = await serveWith({});
  try {
    await f.act('board lead', 'create', { title: 'x', aliases: ['built-rails-9000'], owner: S1, parent: 'W-9', links: { pr: PRURL, source: 'https://x' } });
    const w = f.store.state.work['W-1'];
    assert.deepEqual([w.aliases, w.owner, w.parent, w.links], [[], null, null, { source: 'https://x' }]);
  } finally { f.close(); }
});

test('only the seat an answer was routed to acknowledges it', async () => {
  const S2 = 'sup: stream-2';
  const f = await serveWith({});
  try {
    f.store.appendAll([{ kind: 'ask', payload: { title: 'Q', options: [{ key: 'a', text: 'a' }] } }, { kind: 'answer', target: 'TB-1', payload: { choice: 'a' } }, { kind: 'route', target: 'TB-1', payload: { to: S1 } }], { now: 'n', by: 'test' });
    config.routing.supervisors[S2] = {};
    assert.match((await f.act(S2, 'ack', { ref: 'TB-1', outcome: 'done' }))[1].error, /routed to sup: stream-1/);
    assert.equal((await f.act(S1, 'ack', { ref: 'TB-1', outcome: 'done' }))[0], 200);
  } finally { delete config.routing.supervisors[S2]; f.close(); }
});
