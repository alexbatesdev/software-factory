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
    assert.match((await f.act('local-head', 'ack', { ref: m.id }))[1].error, /may not ack/);
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
