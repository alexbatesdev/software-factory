import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsFor } from '../core/actions.mjs';
import { ACTIONS, refusal } from '../core/capabilities.mjs';

// Events only the factory itself may produce (GitHub readers, Alex's own routes); no board action may mint one.
const GATE_EVENTS = ['mark_ready', 'merged', 'authorize_pr_ready', 'pr_ready_op', 'waive_internal_review', 'retro_close', 'transition', 'alex_review_seen'];
const sample = { ref: 'W-1/R1', work: 'W-1', assignmentId: 'R1', kind: 'implementation', status: 'queued', head: 'abc1234', result: 'clean', id: 'TB-1', to: 'sup', owner: 'sup', title: 't', text: 't', type: 'mark_ready', pr: 'https://github.com/o/r/pull/1', bucket: 'ready', into: 'W-2', note: 'n', evidence: 'e', findingId: 'F1', id: 'TB-1' };

test('no board action can mint a gate event, even when asked to by name', () => {
  for (const action of ACTIONS.filter(a => a !== 'read')) {
    for (const c of commandsFor(action, action === 'settle_finding' ? { ...sample, status: 'resolved' } : sample)) {
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

test('a progress note naming a discovery proposes it as its own record', () => {
  const [c] = commandsFor('progress', { work: 'W-1', discovery: 'Export URL breaks on a query string', text: 'ExportForm appends ?full_data=1' });
  assert.deepEqual(c.payload, { type: 'discovery', text: 'Export URL breaks on a query string', objective: 'ExportForm appends ?full_data=1' });
});

test('a record nobody started can be withdrawn with a reason; started work cannot', async () => {
  const { createWork, applyEvent } = await import('../core/work.mjs');
  const ctx = { now: '2026-11-06T18:00:00Z', by: 'dev' };
  const [c] = commandsFor('withdraw', { work: 'W-1', note: 'trusted reviews run off the board (CLAUDE.md:9)' });
  const w = applyEvent(createWork({ id: 'W-1', title: 'Trusted review #8551' }, ctx), c.payload, ctx).work;
  assert.deepEqual([w.phase, w.completion.withdrawn], ['cancelled', 'trusted reviews run off the board (CLAUDE.md:9)']);
  const started = { ...createWork({ id: 'W-2', title: 'x' }, ctx), assignments: [{ id: 'R1', status: 'started' }] };
  assert.throws(() => applyEvent(started, c.payload, ctx), /started/);
});

test('triage can set the repo a record works in, so a host-repo record reaches its host stream (W-233)', () => {
  const cmds = commandsFor('triage', { work: 'W-1', bucket: 'ready', repo: 'teamwork-mini-mcp' });
  assert.deepEqual(cmds[0], { kind: 'update', target: 'W-1', payload: { repo: 'teamwork-mini-mcp' } });
});
