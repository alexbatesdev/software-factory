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
