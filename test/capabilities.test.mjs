import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ACTIONS, ROLES, refusal } from '../core/capabilities.mjs';

test('each role may take only its own actions', () => {
  assert.equal(refusal('stream-supervisor', 'done'), null);
  assert.match(refusal('questions-router', 'done'), /may not done/);
  assert.match(refusal('local-head', 'route'), /may not route/);
  assert.match(refusal('nobody', 'read'), /not a factory role/);
  assert.match(refusal('board-developer', 'merge'), /not a board action/);
});

test('the board lead may queue work but not start it', () => {
  assert.equal(refusal('board-lead', 'assign', { status: 'queued' }), null);
  assert.match(refusal('board-lead', 'assign', { status: 'started' }), /only queues/);
});

// The role files name their actions in prose; a file that drifts from this table is a second source of truth.
test('every role file lists exactly the actions this table grants it', () => {
  for (const [role, actions] of Object.entries(ROLES)) {
    if (actions === ACTIONS) continue;
    const text = readFileSync(join(homedir(), 'Code/.claude/agents', `${role}.md`), 'utf8');
    const line = text.match(/\*\*Board actions:\*\* (.*)/)[1];
    const named = line.replace(/\(.*?\)/g, '').replace(/\.$/, '').split(',').map(s => s.trim());
    assert.deepEqual(named.sort(), [...actions].sort(), role);
  }
});

test('only local-head pins a stream', () => {
  assert.match(refusal('board-lead', 'set_owner', { pin: 'Alex' }), /only local-head pins/);
  assert.equal(refusal('board-lead', 'set_owner', {}), null);
});

test('the board lead cannot supersede a running assignment by queueing over it', () => {
  assert.match(refusal('board-lead', 'assign', { status: 'queued', supersedes: 'R1' }), /only queues/);
});

test('local-head sets an owner only to pin one', () => {
  assert.equal(refusal('local-head', 'set_owner', { pin: 'Alex' }), null);
  assert.match(refusal('local-head', 'set_owner', {}), /only sets an owner to pin/);
});

test('the board lead adds notes but never relays a worker report', () => {
  assert.equal(refusal('board-lead', 'progress', { work: 'W-1', text: 'seen again' }), null);
  assert.match(refusal('board-lead', 'progress', { work: 'W-1', assignmentId: 'R1', stage: 'working' }), /adds notes/);
});

test('the board lead acks the messages addressed to it', () => {
  assert.equal(refusal('board-lead', 'ack', { ref: 'M-1' }), null);
  assert.match(refusal('board-lead', 'ack', { ref: 'W-1/R1' }), /only messages/);
});
