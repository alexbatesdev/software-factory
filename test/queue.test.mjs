import { test } from 'node:test';
import assert from 'node:assert/strict';
import { queueView } from '../views/queue.mjs';

// W-505 follow-up (Alex 11-16): the one factory queue on one page, in the order streams will take it.
const state = { work: {
  'W-71': { id: 'W-71', title: 'Fix export', phase: 'fixes', priority: 3 }, 'W-76': { id: 'W-76', title: 'Saved views', phase: 'fixes', priority: 3 },
  'W-9': { id: 'W-9', title: 'New thing', phase: 'ready', priority: 2, support: { at: 'x' } }, 'W-235': { id: 'W-235', title: 'Running job', phase: 'implementation' } } };
const plan = [
  { id: 'W-9', action: 'queue', to: 'sup: stream-2', reason: 'ready, sup: stream-2 is free' },
  { id: 'W-71', action: null, request: 'W-71/R5', reason: 'every stream is busy; waits its turn' },
  { id: 'W-76', action: null, request: 'W-76/R2', reason: 'every stream is busy; waits its turn' },
];

test('the queue lists every job in the order streams will take it, saying what each is and why it waits', () => {
  const v = queueView(state, plan, [['sup: stream-1', 'W-235']], ['sup: stream-1', 'sup: stream-2', 'sup: host']);
  assert.deepEqual(v.queue.map(q => [q.pos, q.id, q.job, q.next]), [[1, 'W-9', 'new work', 'going to sup: stream-2'], [2, 'W-71', 'fixes round (R5)', null], [3, 'W-76', 'fixes round (R2)', null]]);
  assert.equal(v.queue[0].title, 'New thing'); assert.equal(v.queue[0].support, true);
  assert.deepEqual(v.streams, [{ label: 'sup: stream-1', busyWith: 'W-235', title: 'Running job' }, { label: 'sup: stream-2', busyWith: null, title: null }, { label: 'sup: host', busyWith: null, title: null }]);
});
