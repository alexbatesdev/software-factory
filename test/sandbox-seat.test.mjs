import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sandboxToken, sandboxSeat } from '../core/sandbox-seat.mjs';
import { roleOf } from '../core/api.mjs';
import { refusal } from '../core/capabilities.mjs';

const SECRET = 'test-secret';
const workers = { 'sbx: stream-1': 'box-1', 'sbx: stream-2': 'box-2' };

test("a sandbox acts only as its own worker, proven by the factory's token, never by a claimed seat", () => {
  const h = (name, token, extra = {}) => ({ 'x-sandbox': name, 'x-sandbox-token': token, ...extra });
  assert.equal(sandboxSeat(h('box-1', sandboxToken(SECRET, 'box-1')), SECRET, workers), 'sbx: stream-1');
  assert.equal(sandboxSeat(h('box-1', sandboxToken(SECRET, 'box-2')), SECRET, workers), null, 'another sandbox\'s token');
  assert.equal(sandboxSeat(h('box-9', sandboxToken(SECRET, 'box-9')), SECRET, workers), null, 'a sandbox that is no worker (Mutation)');
  assert.equal(sandboxSeat(h('box-1', 'guess', { 'x-seat': 'triage board worker' }), SECRET, workers), null);
  assert.equal(sandboxSeat({ 'x-seat': 'triage board worker' }, SECRET, workers), null, 'x-seat is never honoured here');
});

test('a stream worker reads, acks and adds notes (with its branch); it never finishes, reviews or relays', () => {
  const config = { routing: { supervisors: { 'sup: s1': { worker: 'sbx: s1' } } } };
  assert.equal(roleOf(config, 'sbx: s1'), 'sbx-worker');
  assert.equal(refusal('sbx-worker', 'progress', { work: 'W-1', text: 'done: PR #1 at abc', branch: 'alex/x' }), null);
  assert.match(refusal('sbx-worker', 'progress', { work: 'W-1', assignmentId: 'R1', stage: 'started' }), /notes/);
  for (const a of ['done', 'review', 'await_approval', 'assign', 'cancel']) assert.match(refusal('sbx-worker', a), /may not/);
});
