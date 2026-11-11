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
    if (actions === ACTIONS || ['sbx-worker', 'agent-unblocker'].includes(role)) continue; // sbx workers get theirs in the brief, the unblocker in ~/Code/CLAUDE.md
    const text = readFileSync(join(homedir(), 'Code/.claude/agents', `${role}.md`), 'utf8');
    const line = text.match(/\*\*Board actions:\*\* (.*)/)?.[1];
    if (!actions.length) { assert.equal(line, undefined, `${role} has no board actions, so its file names none`); continue; }
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

test('every seat can ack the messages in its own inbox', () => {
  // A trusted reviewer is never messaged (inbox.mjs skips its seat) until its role file grants ack.
  for (const role of Object.keys(ROLES).filter(r => r !== 'trusted-reviewer')) assert.equal(refusal(role, 'ack', { ref: 'M-1' }), null, role);
});

test('a trusted-review pane, under either label form, is a trusted reviewer with no board actions (PR review carve-out, Alex 11-06); its record is trusted-review work', async () => {
  const { roleOf } = await import('../core/api.mjs');
  const { trackOf } = await import('../core/work.mjs');
  for (const seat of ['pr-8434-trusted', 'trusted-review-8434']) {
    assert.equal(roleOf({}, seat), 'trusted-reviewer', seat);
    assert.equal(trackOf({ id: 'W-1', owner: seat }), 'trusted-review', seat);
  }
  assert.equal(roleOf({}, 'pr-8434'), null);
  for (const a of ['read', 'progress', 'ack']) assert.match(refusal('trusted-reviewer', a, { work: 'W-1', text: 'started' }), /may not/, a);
  assert.match(refusal('trusted-reviewer', 'done'), /may not done/);
});

test('the board lead acks the answer to a question it asked, not anyone else\'s (W-260: TB-156, TB-163)', () => {
  const ctx = { seat: 'board lead', questions: { 'TB-156': { from: 'board lead' }, 'TB-9': { from: 'sup: stream-1' } } };
  assert.equal(refusal('board-lead', 'ack', { ref: 'TB-156' }, ctx), null);
  assert.match(refusal('board-lead', 'ack', { ref: 'TB-9' }, ctx), /only messages/);
});
