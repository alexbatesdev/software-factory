import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { boardView } from '../views/board.mjs';

const S1 = 'sup: stream-1';
const ctx = (by = 'test') => ({ now: '2026-10-30T22:00:00.000Z', by });
const card = (s, id) => boardView(s.state, { supervisors: [S1] }).find(c => c.id === id);

test('an answer delivered as a message waits on its seat until acked (row 14)', () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  s.append({ kind: 'update', target: 'W-1', payload: { owner: S1 } }, ctx());
  s.appendAll([{ kind: 'ask', payload: { title: 'Q', options: [{ key: 'a', text: 'a' }], work: 'W-1' } }, { kind: 'answer', target: 'TB-1', payload: { choice: 'a' } }], ctx());
  const { id } = s.append({ kind: 'message', payload: { to: S1, work: 'W-1', about: { answers: 'TB-1' }, text: 'Answer to TB-1: (a)' } }, ctx('board'));
  assert.match(card(s, 'W-1').waiting.text, /your answer to TB-1 was delivered but not acknowledged/);
  s.append({ kind: 'ack_message', target: id }, ctx(S1));
  assert.doesNotMatch(card(s, 'W-1').waiting?.text || '', /TB-1/);
});

test("a worker-stop message shows on the record until the supervisor acts", () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  s.appendAll([{ kind: 'update', target: 'W-1', payload: { owner: S1 } }, ...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
    { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'started', owner: S1, evidence: 'brief' } }], ctx());
  const a = s.state.work['W-1'].assignments.find(x => x.status === 'started');
  s.append({ kind: 'message', payload: { to: S1, work: 'W-1', about: { workerStop: `W-1/${a.id}` }, text: 'worker stopped' } }, ctx('board'));
  assert.match(card(s, 'W-1').waiting.text, new RegExp(`Worker finished; ${S1} notified`));
});

const started = () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  s.appendAll([{ kind: 'update', target: 'W-1', payload: { owner: S1 } }, ...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
    { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'started', owner: S1, evidence: 'brief' } }], ctx());
  return s;
};
const unit = (sup = 'idle', worker = 'working') => ({ id: 'u1', supervisor: { label: S1, status: sup }, worker: { label: 'sbx: stream-1', status: worker } });

test("a stream pane stuck at a prompt puts the record in front of Alex", () => {
  const s = started();
  const c = boardView(s.state, { supervisors: [S1], units: [unit('idle', 'blocked')] }).find(x => x.id === 'W-1');
  assert.match(c.waiting.text, /sbx: stream-1 is waiting at a prompt/);
  assert.equal(c.needs.me, true);
});

test('queued work on a free stream says when the board will wake its supervisor', () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  s.appendAll([{ kind: 'update', target: 'W-1', payload: { owner: S1 } }, ...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
    { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'queued', owner: S1, evidence: 'brief' } }], ctx());
  const since = new Date('2026-10-30T22:00:00').getTime();
  const c = boardView(s.state, { supervisors: [S1], units: [unit('idle', 'idle')], idleSince: { u1: since }, graceMs: 300000 }).find(x => x.id === 'W-1');
  assert.match(c.waiting.text, /stream free; the board wakes sup: stream-1 at 22:05/);
});

test('a worker-stop notice clears once the assignment moves on, and the newest stop wins', () => {
  const s = started();
  const a = s.state.work['W-1'].assignments.find(x => x.status === 'started');
  s.append({ kind: 'message', payload: { to: S1, work: 'W-1', about: { workerStop: 'W-1/R1' }, text: 'old stop' } }, ctx('board'));
  s.append({ kind: 'message', payload: { to: S1, work: 'W-1', about: { workerStop: `W-1/${a.id}` }, text: 'stop' } }, ctx('board'));
  assert.match(card(s, 'W-1').waiting.text, /Worker finished/, 'an older, stale stop message does not hide the current one');
  s.append({ kind: 'event', target: 'W-1', payload: { type: 'progress', assignmentId: a.id, expectedVersion: a.version, stage: 'working', text: 'still going' } }, { now: '2026-10-30T22:10:00.000Z', by: S1 });
  assert.doesNotMatch(card(s, 'W-1').waiting?.text || '', /Worker finished/);
});

test("a record with no stream never takes another pane's prompt as its own", () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'Mutation run' } }, ctx());
  s.appendAll([...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
    { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'started', owner: 'mutation tester', evidence: 'x' } }], ctx());
  const orphan = { id: 'u9', supervisor: null, worker: { label: 'sbx: orphan', status: 'blocked' } };
  const c = boardView(s.state, { supervisors: [S1], units: [orphan] }).find(x => x.id === 'W-1');
  assert.doesNotMatch(c.waiting?.text || '', /waiting at a prompt/);
});

test("a ready record's waiting line and queue position come from the auto-dispatch plan", async () => {
  const { openStore } = await import('../core/store.mjs');
  const { boardView } = await import('../views/board.mjs');
  const s = openStore(), ctx = { now: '2026-11-04T12:00:00.000Z', by: 'test' };
  const ids = ['A', 'B', 'M'].map(t => s.append({ kind: 'create', payload: { title: t } }, ctx).id);
  const queue = [{ id: ids[0], action: null, reason: 'every stream is busy; waits its turn' }, { id: ids[2], action: null, reason: 'Excluded in config.autoDispatch.exclude' }, { id: ids[1], action: null, reason: 'every stream is busy; waits its turn' }];
  const cards = Object.fromEntries(boardView(s.state, { queue }).map(c => [c.id, c]));
  assert.equal(cards[ids[1]].waiting.text, 'In queue, #2: the next free stream takes #1');
  assert.equal(cards[ids[2]].waiting.text, 'Not dispatched: Excluded in config.autoDispatch.exclude');
});

test('a card shows what the exit report says is unverified, and nothing when it says nothing', () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  const report = unverified => s.append({ kind: 'event', target: 'W-1', payload: { type: 'note', text: `Exit report. Changed: a. Proven: b. Unverified: ${unverified} Risk: low.` } }, ctx());
  report('The live GitHub call.');
  assert.equal(card(s, 'W-1').unverified, 'The live GitHub call.');
  report('nothing.');
  assert.equal(card(s, 'W-1').unverified, null);
});
