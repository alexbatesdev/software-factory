import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimRun, validateVerify, planVerify } from '../core/triage-runs.mjs';

const now = '2026-10-28T20:00:00Z';
const claim = () => claimRun({}, { kind: 'verify', scope: ['TB-1', 'TB-2', 'TB-3'], revisionOf: id => `r-${id}`, by: 'Alex', now });

test('a verify run covers questions, each with one of three outcomes; cannot-verify needs the reason', () => {
  const run = claim();
  assert.deepEqual([run.kind, run.scope.map(s => s.question)], ['verify', ['TB-1', 'TB-2', 'TB-3']]);
  const ok = { run: run.id, questions: [
    { id: 'TB-1', revision: 'r-TB-1', outcome: 'live', evidence: 'TW comment 5 still asks' },
    { id: 'TB-2', revision: 'r-TB-2', outcome: 'answered', evidence: 'PR #1 thread: Alex replied "b"' },
    { id: 'TB-3', revision: 'r-TB-3', outcome: 'cannot-verify', evidence: 'no source the agent can read', reason: 'needs the customer' }] };
  assert.equal(validateVerify(run, ok), ok);
  assert.throws(() => validateVerify(run, { ...ok, questions: ok.questions.slice(0, 2) }), /missing TB-3/);
  assert.throws(() => validateVerify(run, { ...ok, questions: [...ok.questions.slice(0, 2), { ...ok.questions[2], reason: '' }] }), /reason/);
  assert.throws(() => validateVerify(run, { ...ok, questions: [{ ...ok.questions[0], outcome: 'maybe' }, ...ok.questions.slice(1)] }), /outcome/);
  assert.throws(() => validateVerify(run, { ...ok, questions: [{ ...ok.questions[0], id: 'TB-9' }, ...ok.questions.slice(1)] }), /outside/);
});

test('a question answered or changed while the run worked is stale, never overwritten', () => {
  const run = claim();
  const p = { run: run.id, questions: ['TB-1', 'TB-2', 'TB-3'].map(id => ({ id, revision: `r-${id}`, outcome: 'live', evidence: 'x' })) };
  const qs = { 'TB-1': { status: 'open' }, 'TB-2': { status: 'answered' }, 'TB-3': { status: 'open' } };
  const plan = planVerify(run, p, qs, id => id === 'TB-3' ? 'changed' : `r-${id}`);
  assert.deepEqual([plan.apply.map(x => x.id), plan.stale.map(x => x.id)], [['TB-1'], ['TB-2', 'TB-3']]);
});
