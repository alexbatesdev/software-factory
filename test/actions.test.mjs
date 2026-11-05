import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsFor } from '../core/actions.mjs';
import { ACTIONS, refusal } from '../core/capabilities.mjs';

// Events only the factory itself may produce (GitHub readers, Alex's own routes); no board action may mint one.
const GATE_EVENTS = ['mark_ready', 'merged', 'authorize_pr_ready', 'pr_ready_op', 'waive_internal_review', 'retro_close', 'transition', 'alex_review_seen'];
const sample = { ref: 'W-1/R1', work: 'W-1', assignmentId: 'R1', kind: 'implementation', status: 'queued', head: 'abc1234', result: 'clean', id: 'TB-1', to: 'sup', owner: 'sup', title: 't', text: 't', type: 'mark_ready', pr: 'https://github.com/o/r/pull/1', bucket: 'ready', into: 'W-2', note: 'n', evidence: 'e', id: 'TB-1' };

test('no board action can mint a gate event, even when asked to by name', () => {
  for (const action of ACTIONS.filter(a => a !== 'read')) {
    for (const c of commandsFor(action, sample)) {
      assert.ok(!['import', 'absorb'].includes(c.kind), `${action} emits ${c.kind}`);
      if (c.kind === 'event') assert.ok(!GATE_EVENTS.includes(c.payload.type), `${action} emits ${c.payload.type}`);
    }
  }
});

test('merge and raw event writes are not actions for any role', () => {
  for (const a of ['merge', 'merged', 'event', 'mark_ready']) assert.match(refusal('board-developer', a), /not a board action/);
});

test('a blocked report carries what it waits on to the board', () => {
  const [c] = commandsFor('progress', { work: 'W-1', assignmentId: 'R1', expectedVersion: 2, stage: 'blocked', waitingOn: 'TB-9', text: 'x' });
  assert.equal(c.payload.waitingOn, 'TB-9');
});
