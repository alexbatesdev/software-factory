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
  return { store, act, inbox, port: server.address().port, close: () => server.close() };
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
    await f.act(S1, 'ask', { title: 'Which way?', options: [{ key: 'a', text: 'this' }], work: 'W-1', wwbd: 'no passage applies' });
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
  return { store, act, base, close: () => server.close() };
}
const started = f => f.store.appendAll([
  { kind: 'create', payload: { title: 'Build it', links: { pr: PRURL } } }, { kind: 'update', target: 'W-1', payload: { owner: S1, stream: S1 } },
  ...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
  { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'started', owner: S1, evidence: 'brief' } },
], { now: 'n', by: 'test' });
const PRURL = 'https://github.com/acme-org/app/pull/1';
const REPORT = { changed: 'c', proven: 'p', unverified: 'nothing', risk: 'none' };

test('done is checked against a fresh GitHub read of the PR head', async () => {
  const f = await serveWith({ readPr: async url => ({ url, head: 'bbb2222', state: 'OPEN', isDraft: true }) });
  try {
    started(f);
    const a = f.store.state.work['W-1'].assignments.find(x => x.status === 'started');
    const [code, body] = await f.act(S1, 'done', { work: 'W-1', assignmentId: a.id, expectedVersion: a.version, head: 'aaa1111', report: REPORT });
    assert.equal(code, 400); assert.match(body.error, /GitHub shows bbb2222/);
    assert.equal((await f.act(S1, 'done', { work: 'W-1', assignmentId: a.id, expectedVersion: a.version, head: 'bbb2222', report: REPORT }))[0], 200);
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
    await f.act('board lead', 'create', { title: 'x', aliases: ['app-9000'], owner: S1, parent: 'W-9', links: { pr: PRURL, source: 'https://x' } });
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

test('the page and board view are served; a read-only factory refuses writes', async () => {
  const f = await serveWith({ readOnly: true, config: { ...config, buckets: { order: ['untriaged'], labels: {} } } });
  try {
    f.store.append({ kind: 'create', payload: { title: 'Seen' } }, { now: 'n', by: 'test' });
    assert.equal((await f.act('local-head', 'create', { title: 'x' }))[0], 405);
    const base = f.base;
    assert.match(await (await fetch(`${base}/`)).text(), /<title>Software Factory<\/title>/);
    const b = await (await fetch(`${base}/api/board`)).json();
    assert.deepEqual([b.mode, b.cards.map(c => c.title)], ['shadow (read-only)', ['Seen']]);
  } finally { f.close(); }
});

test("prioritize marks a record as Alex's priority and clears it back to the default", async () => {
  const f = await serveWith({ config: { ...config, roles: { ...config.roles, 'triage board worker': 'board-developer' } } });
  try {
    await f.act('triage board worker', 'create', { title: 'Urgent fix' });
    await f.act('triage board worker', 'prioritize', { work: 'W-1' });
    assert.equal(f.store.state.work['W-1'].priority, 1);
    await f.act('triage board worker', 'prioritize', { work: 'W-1', on: false });
    assert.equal(f.store.state.work['W-1'].priority, 3);
    assert.match((await f.act('board lead', 'prioritize', { work: 'W-1' }))[1].error, /may not prioritize/);
  } finally { f.close(); }
});

test("a review at a head GitHub already shows but the board hasn't polled yet records that head first (W-231)", async () => {
  const remote = { url: PRURL, head: 'aaa1111', state: 'OPEN', isDraft: true };
  const f = await serveWith({ readPr: async () => remote });
  try {
    started(f);
    const a = f.store.state.work['W-1'].assignments.find(x => x.status === 'started');
    assert.equal((await f.act(S1, 'done', { work: 'W-1', assignmentId: a.id, expectedVersion: a.version, head: 'aaa1111', report: REPORT }))[0], 200);
    remote.head = 'bbb2222';
    const [bad, err] = await f.act(S1, 'review', { work: 'W-1', head: 'ccc3333', result: 'clean', by: 'sbx: s1 internal-review' });
    assert.equal(bad, 400); assert.match(err.error, /current head/);
    assert.equal((await f.act(S1, 'review', { work: 'W-1', head: 'bbb2222', result: 'clean', by: 'sbx: s1 internal-review' }))[0], 200);
    const w = f.store.state.work['W-1'];
    assert.deepEqual([w.head, w.reviews.at(-1).head], ['bbb2222', 'bbb2222']);
  } finally { f.close(); }
});

test('a record whose PR Alex closed resolves only once GitHub shows the PR closed (W-124: TB-126 a)', async () => {
  const remote = { url: PRURL, head: 'aaa1111', state: 'OPEN', isDraft: true };
  const f = await serveWith({ readPr: async () => remote });
  try {
    started(f);
    const [bad, err] = await f.act('triage board worker', 'resolve', { work: 'W-1', note: 'Alex closed the PR (TB-126 a)' });
    assert.equal(bad, 400); assert.match(err.error, /ready gate/);
    remote.state = 'CLOSED';
    assert.equal((await f.act('triage board worker', 'resolve', { work: 'W-1', note: 'Alex closed the PR (TB-126 a)' }))[0], 200);
    assert.equal(f.store.state.work['W-1'].phase, 'done');
  } finally { f.close(); }
});

test('ask refuses a second open question on a record unless marked distinct, and the asker can withdraw its own (W-274: TB-176/TB-177)', async () => {
  const f = await serve();
  try {
    await f.act('local-head', 'create', { title: 'Fix it' });
    const q = { title: 'Which rule?', promptedBy: 'review', work: 'W-1', wwbd: 'no passage applies' };
    assert.equal((await f.act(S1, 'ask', q))[0], 200);
    const [code, body] = await f.act('board lead', 'ask', q);
    assert.equal(code, 409);
    assert.match(body.error, /TB-1 .*Which rule/);
    assert.equal((await f.act('board lead', 'ask', { ...q, distinct: true }))[0], 200);
    assert.match((await f.act(S1, 'ask', { withdraw: 'TB-2', note: 'dup' }))[1].error, /only questions it asked/);
    assert.equal((await f.act('board lead', 'ask', { withdraw: 'TB-2', note: 'duplicate of TB-1' }))[0], 200);
    assert.equal(f.store.state.questions['TB-2'].status, 'superseded');
  } finally { f.close(); }
});

test('the server serves each seat its current tool table', async () => {
  const f = await serveWith({});
  try {
    const tools = await (await fetch(`${f.base}/api/tools`, { headers: { 'x-seat': 'questions router' } })).json();
    assert.deepEqual(tools.map(t => t.name).sort(), ['ack', 'create', 'inbox', 'questions', 'read', 'route', 'set_owner']);
    assert.ok(tools.every(t => t.inputSchema?.type === 'object'));
  } finally { f.close(); }
});

test('a question is added to with ask amend: its asker or the board lead appends a note; a closed one refuses', async () => {
  const f = await serve();
  try {
    await f.act('local-head', 'create', { title: 'Fix it' });
    const q = { title: 'Which rule?', promptedBy: 'review', work: 'W-1', wwbd: 'no passage applies' };
    await f.act(S1, 'ask', q);
    assert.match((await f.act('local-head', 'ask', q))[1].error, /amend: TB-1/, 'the 409 names how to add to it');
    assert.equal((await f.act(S1, 'ask', { amend: 'TB-1', note: 'Reviewer also asked about B.' }))[0], 200);
    assert.equal((await f.act('board lead', 'ask', { amend: 'TB-1', note: 'Same as W-9.' }))[0], 200);
    assert.match((await f.act('local-head', 'ask', { amend: 'TB-1', note: 'x' }))[1].error, /only questions it asked/);
    assert.deepEqual(f.store.state.questions['TB-1'].amendments.map(a => [a.note, a.by]), [['Reviewer also asked about B.', S1], ['Same as W-9.', 'board lead']]);
    assert.equal(f.store.state.questions['TB-1'].status, 'open');
    await f.act(S1, 'ask', { withdraw: 'TB-1', note: 'settled' });
    assert.match((await f.act(S1, 'ask', { amend: 'TB-1', note: 'late' }))[1].error, /not open/);
    assert.deepEqual(f.store.replay().questions, f.store.state.questions, 'replay rebuilds the amendments');
  } finally { f.close(); }
});

test("code work is recorded done only with the Definition of Done's exit report, which lands on the record", async () => {
  const f = await serveWith({ readPr: async url => ({ url, head: 'bbb2222', state: 'OPEN', isDraft: true }) });
  try {
    started(f);
    const a = f.store.state.work['W-1'].assignments.find(x => x.status === 'started');
    const base = { work: 'W-1', assignmentId: a.id, expectedVersion: a.version, head: 'bbb2222' };
    const [code, body] = await f.act(S1, 'done', base);
    assert.equal(code, 400); assert.match(body.error, /exit report.*DEFINITION_OF_DONE/s);
    const report = { changed: 'guarded the export', proven: 'spec red then green', unverified: 'large-tenant timing', risk: 'none known' };
    assert.equal((await f.act(S1, 'done', { ...base, report }))[0], 200);
    assert.match(f.store.state.work['W-1'].updates.at(-1).text, /^Exit report.*Unverified: large-tenant timing/s);
  } finally { f.close(); }
});

test('parking a record in intake needs a release condition, a review date or a deferral, unless it is already held (W-317 phase 4)', async () => {
  const f = await serve();
  try {
    await f.act('local-head', 'create', { title: 'Parked' });
    const [code, body] = await f.act('board lead', 'triage', { work: 'W-1', bucket: 'intake', note: 'nothing for now' });
    assert.equal(code, 409); assert.match(body.error, /untilMerged.*untilAnswered.*reviewBy.*deferredTo/s);
    assert.equal((await f.act('board lead', 'triage', { work: 'W-1', bucket: 'intake', note: 'n', untilMerged: '#5' }))[0], 200);
    assert.equal((await f.act('board lead', 'triage', { work: 'W-1', bucket: 'intake', note: 'still held' }))[0], 200, 'already held: a re-triage note needs nothing new');
  } finally { f.close(); }
});

test('a re-triage that releases the last hold must say what holds it next, and a reviewer must be a real seat (review of e651cea)', async () => {
  const f = await serve();
  try {
    await f.act('local-head', 'create', { title: 'Parked' });
    assert.equal((await f.act('board lead', 'triage', { work: 'W-1', bucket: 'intake', note: 'n', reviewBy: '2026-11-01', reviewer: 'board lead' }))[0], 200);
    assert.equal((await f.act('board lead', 'triage', { work: 'W-1', bucket: 'intake', note: 'n', releaseHold: 'review by 2026-11-01 (board lead)' }))[0], 409, 'releasing the only hold leaves nothing to release it');
    assert.equal((await f.act('board lead', 'triage', { work: 'W-1', bucket: 'intake', note: 'n', releaseHold: 'review by 2026-11-01 (board lead)', reviewBy: '2026-11-20', reviewer: 'board lead' }))[0], 200);
    const [code, body] = await f.act('board lead', 'triage', { work: 'W-1', bucket: 'intake', note: 'n', reviewBy: '2026-11-20', reviewer: 'product' });
    assert.equal(code, 409); assert.match(body.error, /reviewer/);
  } finally { f.close(); }
});

test("a record-level wait on Alex is refused while the record has an open question: block on the TB-n, which clears when he answers (W-365: W-271, TB-214)", async () => {
  const f = await serve();
  try {
    await f.act('local-head', 'create', { title: 'Narrowing' });
    f.store.state.questions['TB-214'] = { status: 'open', work: 'W-1', title: 'narrowing-only vs own_ids?' };
    const [code, body] = await f.act(S1, 'progress', { work: 'W-1', waitingOn: 'Alex: pick narrowing-only vs own_ids', actor: 'alex', text: 'HELD' });
    assert.equal(code, 409); assert.match(body.error, /TB-214/);
    assert.equal((await f.act(S1, 'progress', { work: 'W-1', waitingOn: 'product sign-off', actor: 'other', text: 'x' }))[0], 200, 'a wait on someone else is fine');
    f.store.state.questions['TB-214'].status = 'answered';
    assert.equal((await f.act(S1, 'progress', { work: 'W-1', waitingOn: 'Alex runs the migration script', actor: 'alex', text: 'x' }))[0], 200, 'with no open question, a manual action of Alex is fine');
  } finally { f.close(); }
});

test('done replacesPr must name the PR the record carries (W-371)', async () => {
  const f = await serve();
  try {
    await f.act('local-head', 'create', { title: 'ACME' });
    f.store.state.work['W-1'].links.pr = 'https://github.com/acme-org/app/pull/1';
    const [code, body] = await f.act(S1, 'done', { work: 'W-1', pr: 'https://github.com/acme-org/app/pull/3', replacesPr: 'https://github.com/acme-org/app/pull/2', head: 'abc1234' });
    assert.equal(code, 409); assert.match(body.error, /pull\/1/);
  } finally { f.close(); }
});

test("a finished record whose own PR GitHub shows closed unmerged can be closed by triage, freeing its stream (W-378: W-288, #8642 closed, work carried by W-271's #8635)", async () => {
  const PR = 'https://github.com/acme-org/app/pull/8642';
  let state = 'OPEN';
  const f = await serveWith({ readPr: async url => ({ url, head: 'aaa1111', state, isDraft: false }) });
  try {
    await f.act('local-head', 'create', { title: 'Narrowing' });
    await f.act('local-head', 'create', { title: 'Port' });
    f.store.state.work['W-1'].links.pr = PR;
    f.store.state.work['W-1'].assignments = [{ id: 'R1', kind: 'implementation', status: 'done', version: 2 }, { id: 'R5', kind: 'fixes', status: 'cancelled', version: 2 }];
    f.store.state.work['W-1'].phase = 'awaiting_human_approval';
    const close = () => f.act('board lead', 'triage', { work: 'W-1', bucket: 'close', reason: 'duplicate', of: 'W-2', note: 'shipped in #8635' });
    assert.notEqual((await close())[0], 200, 'PR still open: refused');
    state = 'CLOSED';
    assert.equal((await close())[0], 200);
    assert.equal(f.store.state.work['W-1'].phase, 'cancelled');
  } finally { f.close(); }
});

test("a second fixes assignment on a PR another record is already fixing is refused (W-377: #8363 queued on two streams)", async () => {
  const f = await serve();
  try {
    const PR = 'https://github.com/acme-org/app/pull/8363';
    await f.act('local-head', 'create', { title: 'W-76 shape' }); await f.act('local-head', 'create', { title: 'W-152 shape' });
    for (const id of ['W-1', 'W-2']) f.store.state.work[id].links.pr = PR;
    f.store.state.work['W-1'].assignments = [{ id: 'R1', kind: 'fixes', status: 'started', owner: S1, version: 1 }];
    const [code, body] = await f.act('board lead', 'assign', { work: 'W-2', assignmentId: 'R2', kind: 'fixes', status: 'queued', owner: 'sup: stream-2', evidence: 'conflict' });
    assert.equal(code, 409); assert.match(body.error, /W-1 R1/);
  } finally { f.close(); }
});

test('the page loads its markdown libraries from the factory itself, never a CDN, and only known vendor files are served', async () => {
  const f = await serve();
  try {
    const { readFileSync } = await import('node:fs');
    const page = readFileSync(new URL('../views/index.html', import.meta.url), 'utf8');
    assert.doesNotMatch(page, /<script src="https?:/, 'no CDN scripts: the dashboard works offline');
    const base = `http://127.0.0.1:${f.port}`;
    for (const src of page.match(/<script src="([^"]+)"/g).map(x => x.slice(13, -1))) assert.equal((await fetch(base + src)).status, 200, src);
    assert.equal((await fetch(`${base}/vendor/../core/api.mjs`)).status, 404);
  } finally { f.close(); }
});

test("a message goes only to a seat that can read and ack it; the agent unblocker can (W-414)", async () => {
  const f = await serve();
  try {
    const [code, body] = await f.act('board lead', 'message', { to: 'stranger pane', text: 'hello' });
    assert.equal(code, 409, JSON.stringify(body));
    assert.match(body.error, /can't read or ack/);
    const { ROLES } = await import('../core/capabilities.mjs');
    assert.deepEqual(ROLES['agent-unblocker'], ['read', 'ack']);
    const live = JSON.parse((await import('node:fs')).readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
    assert.equal(live.roles['agent-unblocker'], 'agent-unblocker');
    assert.equal((await f.act('board lead', 'message', { to: S1, text: 'hi' }))[0], 200);
  } finally { f.close(); }
});

test('a review discovery claimed as pre-existing on main must show the faulty code on origin/main, which the factory checks (W-435: W-434 came from the PR itself)', async () => {
  const store = openStore(':memory:', { supervisors: [S1] });
  store.append({ kind: 'create', payload: { title: 'Phase 10', stream: S1 } }, { now: '2026-11-12T00:00:00.000Z', by: 'test' });
  const seen = [];
  const onMain = async (repo, m) => { seen.push([repo, m.sha, m.path]); return m.code === 'reject_terminated(worker)'; };
  const server = http.createServer(createApi({ store, config, onMain, now: () => '2026-11-12T00:30:00.000Z' }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const act = async args => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-seat': S1, 'x-factory': '1' }, body: JSON.stringify({ action: 'progress', args: { work: 'W-1', ...args } }) }); return [r.status, await r.json()]; };
  try {
    const d = { discovery: 'Terminated-today workers keep their seats', text: 'Pre-existing since phase 9 on main.' };
    let [code, body] = await act(d);
    assert.equal(code, 409); assert.match(body.error, /onMain/);
    [code, body] = await act({ ...d, onMain: { sha: 'a5b21fd', path: 'app/adp_workers_adapter.rb', code: 'worker_section_for(w)' } });
    assert.equal(code, 409, 'the quoted code is not on main at that sha'); assert.match(body.error, /isn't on origin\/main/);
    assert.equal((await act({ ...d, onMain: { sha: 'a5b21fd', path: 'app/adp_workers_adapter.rb', code: 'reject_terminated(worker)' } }))[0], 200);
    assert.equal((await act({ discovery: 'A new edge case', text: 'Found while testing.' }))[0], 200, 'a discovery that claims nothing about main needs no proof');
    assert.deepEqual(seen[0], [(await import('../core/work.mjs')).DEFAULT_REPO, 'a5b21fd', 'app/adp_workers_adapter.rb']);
  } finally { server.close(); }
});

test('an exit report is kept as a structured record of its run, and still reads as the same note (evolution phase 1, step 1)', async () => {
  const f = await serveWith({ readPr: async url => ({ url, head: 'bbb2222', state: 'OPEN', isDraft: true }) });
  try {
    started(f);
    const a = f.store.state.work['W-1'].assignments.find(x => x.status === 'started');
    const report = { changed: 'guarded the export', proven: 'spec red then green', unverified: 'large-tenant timing', risk: 'none known' };
    assert.equal((await f.act(S1, 'done', { work: 'W-1', assignmentId: a.id, expectedVersion: a.version, head: 'bbb2222', report }))[0], 200);
    const w = f.store.state.work['W-1'];
    assert.equal(w.reports.length, 1);
    const r = w.reports[0];
    assert.deepEqual(r.run, { work: 'W-1', assignment: a.id, version: a.version, attempt: 1 });
    assert.deepEqual([r.changed, r.proven, r.unverified, r.risk, r.head], [report.changed, report.proven, report.unverified, report.risk, 'bbb2222']);
    assert.equal(w.updates.filter(u => /^Exit report\./.test(u.text)).at(-1).text, 'Exit report. Changed: guarded the export Proven: spec red then green Unverified: large-tenant timing Risk: none known', 'old readers see the same note');
    assert.deepEqual(f.store.replay().work['W-1'].reports, w.reports, 'replay rebuilds it');
  } finally { f.close(); }
});

test("a worker's note naming its assignment lands first time, as a note; the stage stays the supervisor's (W-477: W-86 R8)", async () => {
  const store = openStore(':memory:', { supervisors: [S1] });
  const server = http.createServer(createApi({ store, config: { ...config, routing: { supervisors: { [S1]: { worker: 'sbx: stream-1' } } } }, now: () => '2026-11-13T18:25:00.000Z' }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const act = async args => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-seat': 'sbx: stream-1', 'x-factory': '1' }, body: JSON.stringify({ action: 'progress', args: { work: 'W-1', ...args } }) }); return [r.status, await r.json()]; };
  try {
    started({ store });
    const [code, body] = await act({ assignmentId: 'R2', expectedVersion: 1, stage: 'blocked', waitingOn: 'TB-9', text: 'specs green, pushing' });
    assert.equal(code, 200, JSON.stringify(body));
    const w = store.state.work['W-1'];
    assert.equal(w.assignments[0].status, 'started', 'only the supervisor records stages');
    assert.ok(!w.waitingOn, 'a worker note never parks the record');
    assert.match(w.updates.at(-1).text, /R2.*blocked.*TB-9.*specs green, pushing/);
  } finally { server.close(); }
});
