import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimRun, reconcileRunsOnStart, validateResults, planApply, runDigest } from '../core/triage-runs.mjs';

const T = '2026-10-27T17:00:00.000Z';
const works = { 'W-1': { id: 'W-1', phase: 'clarification', updatedAt: 'r1', owner: null }, 'W-2': { id: 'W-2', phase: 'intake', updatedAt: 'r2', owner: null } };
const run = () => ({ id: 'TR-1', status: 'running', scope: [{ work: 'W-1', revision: 'r1' }, { work: 'W-2', revision: 'r2' }] });
const item = (work, revision, extra = {}) => ({ work, revision, bucket: 'ready', summary: 's', evidence: 'e', ...extra });

test('only one run at a time: starting, running and uncertain block a new one', () => {
  const runs = {};
  const a = claimRun(runs, { scope: ['W-1'], works, by: 'Alex', now: T });
  assert.equal(a.status, 'starting');
  assert.throws(() => claimRun(runs, { scope: ['W-2'], works, by: 'Alex', now: T }), /already/);
  runs[a.id].status = 'uncertain';
  assert.throws(() => claimRun(runs, { scope: ['W-2'], works, by: 'Alex', now: T }), /uncertain/);
  runs[a.id].status = 'needs-attention';
  assert.throws(() => claimRun(runs, { scope: ['W-2'], works, by: 'Alex', now: T }), /needs-attention/, 'a missing result may still arrive');
  runs[a.id].status = 'abandoned';
  assert.equal(claimRun(runs, { scope: ['W-2'], works, by: 'Alex', now: T }).id, 'TR-2');
});

test('a run interrupted while starting is uncertain after a restart, never relaunched', () => {
  const runs = reconcileRunsOnStart({ 'TR-1': { id: 'TR-1', status: 'starting', steps: [] } }, T);
  assert.equal(runs['TR-1'].status, 'uncertain');
});

test('results are bounded to the run scope and schema', () => {
  assert.throws(() => validateResults(run(), { run: 'TR-1', items: [item('W-9', 'x')] }), /scope/);
  assert.throws(() => validateResults(run(), { run: 'TR-1', items: [item('W-1', 'r1', { bucket: 'done' })] }), /bucket/);
  assert.throws(() => validateResults(run(), { run: 'TR-1', items: [item('W-1', 'r1', { questions: Array(6).fill({ title: 'q', options: [{ key: 'a', text: 'x' }, { key: 'b', text: 'y' }] }) })] }), /questions/);
  assert.throws(() => validateResults(run(), { run: 'TR-2', items: [] }), /run/);
  assert.doesNotThrow(() => validateResults(run(), { run: 'TR-1', items: [item('W-1', 'r1'), { work: 'W-2', revision: 'r2', skipped: true, reason: 'not enough evidence read' }] }));
});

test('a record that changed, closed or got an owner since the run started is stale, not overwritten', () => {
  const now = { ...works, 'W-2': { ...works['W-2'], updatedAt: 'r2-later' } };
  const p = planApply(run(), { run: 'TR-1', items: [item('W-1', 'r1'), item('W-2', 'r2')] }, now);
  assert.deepEqual(p.apply.map(x => x.work), ['W-1']);
  assert.deepEqual(p.stale.map(x => x.work), ['W-2']);
  const closed = planApply(run(), { run: 'TR-1', items: [item('W-1', 'r1')] }, { ...works, 'W-1': { ...works['W-1'], phase: 'done' } });
  assert.deepEqual(closed.stale.map(x => x.reason), ['W-1 is done']);
});

test('the same payload digests the same', () => {
  const p = { run: 'TR-1', items: [item('W-1', 'r1')] };
  assert.equal(runDigest(p), runDigest(JSON.parse(JSON.stringify(p))));
});

test('results must account for every scoped item once, at the run revision, with evidence', () => {
  assert.throws(() => validateResults(run(), { run: 'TR-1', items: [item('W-1', 'r1')] }), /W-2/, 'every scope item assessed or explicitly skipped');
  assert.throws(() => validateResults(run(), { run: 'TR-1', items: [item('W-1', 'r1'), item('W-1', 'r1')] }), /once/);
  assert.throws(() => validateResults(run(), { run: 'TR-1', items: [item('W-1', 'other'), item('W-2', 'r2')] }), /revision/);
  assert.throws(() => validateResults(run(), { run: 'TR-1', items: [item('W-1', 'r1', { evidence: '' }), item('W-2', 'r2')] }), /evidence/);
});

test('planApply compares the current input revision, not just updatedAt', () => {
  const p = planApply(run(), { run: 'TR-1', items: [item('W-1', 'r1'), item('W-2', 'r2')] }, works, id => (id === 'W-1' ? 'r1-after-an-answer' : works[id].updatedAt));
  assert.deepEqual(p.stale.map(x => x.work), ['W-1']);
});
