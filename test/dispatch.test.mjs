import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoDispatchPlan } from '../core/dispatch.mjs';

const S1 = 'sup: stream-1 (support+sec)', S2 = 'sup: stream-conf-stack';
const cfg = { supervisors: { [S1]: { areas: 'PED', match: ['position end date', 'support'] }, [S2]: { areas: 'ATS', match: ['ats', 'ashby'] } }, exclude: ['W-67'], mutationBranch: 'mutation' };
// The server records a supervisor owner as the stream (ensureStream); fixtures mirror that.
const w = (id, over = {}) => { const x = { id, title: 'Something', phase: 'ready', priority: 3, owner: S1, openQuestions: 0, openDeps: [], externalDeps: [], requests: [], assignments: [], links: {}, ...over }; return { stream: [S1, S2].includes(x.owner) ? x.owner : null, ...x }; };
const plan = (works, terminals = []) => Object.fromEntries(autoDispatchPlan(works, cfg, { terminals }).map(p => [p.id, p]));

test('a ready, unblocked record with an idle stream dispatches; a queued one without a request gets one', () => {
  const p = plan([w('W-1'), w('W-2', { phase: 'queued', owner: S2 })]);
  assert.deepEqual([p['W-1'].action, p['W-2'].action], ['queue', 'request']);
  assert.match(p['W-1'].reason, /no open questions/);
});

test('a stream with active work makes the next record wait its turn, one dispatch per stream', () => {
  const busy = plan([w('W-1', { phase: 'implementation' }), w('W-2')]);
  assert.match(busy['W-2'].reason, /W-1/);
  assert.equal(busy['W-2'].action, null);
  const two = plan([w('W-3', { priority: 2 }), w('W-4')]);
  assert.deepEqual([two['W-3'].action, two['W-4'].action], ['queue', null]);
  const both = plan([w('W-7', { phase: 'awaiting_human_approval', assignments: [{ kind: 'implementation', status: 'queued' }] }), w('W-8', { phase: 'fixes', assignments: [{ kind: 'fixes', status: 'started' }] }), w('W-9')]);
  assert.match(both['W-9'].reason, /busy with W-8/, 'names the job running, not one queued behind it');
  const reviewing = plan([w('W-5', { phase: 'review' }), w('W-6')]);
  assert.equal(reviewing['W-6'].action, 'queue', 'a review does not hold the worker');
});

test('questions, dependencies, external deps, holds, Mutation, trusted reviews and Terminals never dispatch', () => {
  const p = plan([
    w('W-10', { openQuestions: 1 }), w('W-11', { openDeps: ['W-9'] }), w('W-12', { externalDeps: [{ text: '#8050 merges' }] }),
    w('W-13', { intakeHold: { by: 'Alex' } }), w('W-67'), w('W-14', { links: { branch: 'alex/mutation-tester' } }),
    w('W-15', { owner: 'pr-1-trusted-review' }), w('W-16', { owner: 'sup: in-terminals' }),
  ], ['sup: in-terminals']);
  for (const [id, re] of [['W-10', /question/], ['W-11', /W-9/], ['W-12', /8050/], ['W-13', /hold/], ['W-67', /Mutation|excluded/], ['W-14', /Mutation/], ['W-15', /trusted review/], ['W-16', /Terminals/]])
    assert.deepEqual([p[id].action, re.test(p[id].reason)], [null, true], `${id}: ${p[id].reason}`);
});

test('an unowned record takes a stream only when exactly one stream matches its topic', () => {
  const p = plan([w('W-20', { owner: null, title: 'Ashby send values' }), w('W-21', { owner: null, title: 'Support: Ashby position end date' }), w('W-22', { owner: null, title: 'Speed up seeds' })]);
  assert.deepEqual([p['W-20'].action, p['W-20'].owner], ['queue', S2]);
  assert.equal(p['W-21'].action, null); assert.match(p['W-21'].reason, /unrouted.*2 streams/);
  assert.equal(p['W-22'].action, null); assert.match(p['W-22'].reason, /unrouted/);
});

test('a queued record already requested or assigned is left to its supervisor', () => {
  const p = plan([w('W-30', { phase: 'queued', requests: [{ type: 'dispatch', ack: null }] }), w('W-31', { phase: 'queued', owner: S2, requests: [{ type: 'dispatch', ack: { outcome: 'received' } }] })]);
  assert.equal(p['W-30'], undefined);
  assert.equal(p['W-31'], undefined);
});
