import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoDispatchPlan } from '../core/dispatch.mjs';

const S1 = 'sup: stream-1 (support+sec)', S2 = 'sup: stream-conf-stack';
const cfg = { supervisors: { [S1]: { areas: 'PED', match: ['position end date', 'support'] }, [S2]: { areas: 'ATS', match: ['ats', 'ashby'] } }, exclude: ['W-67'], mutationBranch: 'mutation' };
// The server records a supervisor owner as the stream (ensureStream); fixtures mirror that, pinned unless a test says otherwise.
const w = (id, over = {}) => { const x = { id, title: 'Something', phase: 'ready', priority: 3, owner: S1, openQuestions: 0, openDeps: [], externalDeps: [], requests: [], assignments: [], links: {}, ...over }; const stream = [S1, S2].includes(x.owner) ? x.owner : null; return { stream, streamPin: stream ? { by: 'test' } : null, ...x }; };
const loose = (id, over = {}) => w(id, { streamPin: null, ...over });
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

test('work no stream is bound to goes to the least-loaded free stream, whatever its topic', () => {
  const p = plan([w('W-1', { phase: 'review' }), w('W-2', { phase: 'queued', requests: [{ type: 'dispatch', ack: { outcome: 'received' } }] }),
    loose('W-20', { owner: null, title: 'Ashby send values' }), loose('W-21', { title: 'Position end date' })]);
  assert.deepEqual([p['W-20'].action, p['W-20'].to, p['W-20'].owner], ['queue', S2, S2]);
  assert.match(p['W-20'].reason, /least loaded/);
  assert.deepEqual([p['W-21'].action, p['W-21'].to], ['queue', S1], 'S2 took W-20 this tick, so S1 is the free one');
});

test('a never-started record leaves a busy stream for a free one', () => {
  const p = plan([w('W-1', { phase: 'implementation' }), loose('W-2', { phase: 'queued' })]);
  assert.deepEqual([p['W-2'].action, p['W-2'].to, p['W-2'].owner], ['request', S2, S2]);
});

test('pinned, already-worked and same-branch records go to their own stream, not the free one', () => {
  const worked = { assignments: [{ kind: 'implementation', status: 'done' }] };
  const p = plan([w('W-1', { phase: 'implementation' }), w('W-2'), loose('W-3', worked),
    loose('W-9', { phase: 'ready_for_human', ...worked }), loose('W-4', { owner: null, deps: ['W-9'] }), loose('W-5', { owner: null, related: [{ to: 'W-9', kind: 'same-work' }] })]);
  for (const [id, why] of [['W-2', /pinned/], ['W-3', /already worked/], ['W-4', /W-9 shares/], ['W-5', /W-9 shares/]])
    assert.deepEqual([p[id].action, /busy with W-1/.test(p[id].reason), why.test(p[id].reason)], [null, true, true], `${id}: ${p[id].reason}`);
});

test('when every stream is busy, unbound work waits', () => {
  const p = plan([w('W-1', { phase: 'implementation' }), w('W-2', { phase: 'fixes', owner: S2 }), loose('W-3')]);
  assert.equal(p['W-3'].action, null);
  assert.match(p['W-3'].reason, /every stream is busy/);
});

test('a queued record already requested or assigned is left to its supervisor', () => {
  const p = plan([w('W-30', { phase: 'queued', requests: [{ type: 'dispatch', ack: null }] }), w('W-31', { phase: 'queued', owner: S2, requests: [{ type: 'dispatch', ack: { outcome: 'received' } }] })]);
  assert.equal(p['W-30'], undefined);
  assert.equal(p['W-31'], undefined);
});

test('priority work waits only for what the stream is running, not for work queued ahead of it', () => {
  const queuedAhead = w('W-1', { phase: 'queued', assignments: [{ kind: 'implementation', status: 'queued' }], requests: [{ type: 'dispatch', ack: { outcome: 'received' } }] });
  assert.equal(plan([queuedAhead, w('W-2', { priority: 1 })])['W-2'].action, 'queue');
  assert.equal(plan([queuedAhead, w('W-3')])['W-3'].action, null, 'ordinary work still waits its turn');
  const running = w('W-1', { phase: 'implementation', assignments: [{ kind: 'implementation', status: 'started' }] });
  assert.match(plan([running, w('W-2', { priority: 1 })])['W-2'].reason, /busy with W-1/, 'it never interrupts running work');
});

// One source for queue order: a second sort on priority in the core would let the two queues disagree.
test('queue order is decided only by queueOrder in core/work.mjs', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../core/', import.meta.url);
  const copies = readdirSync(dir).filter(f => f !== 'work.mjs' && /priority \?\? 3/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(copies, []);
});

test("an internal review the stream's own worker is running holds the stream", () => {
  const c = { ...cfg, supervisors: { [S1]: { worker: 'sbx: stream-1' }, [S2]: { worker: 'sbx: stream-conf-stack' } } };
  const p = Object.fromEntries(autoDispatchPlan([w('W-1', { phase: 'rereview', assignments: [{ id: 'R3', kind: 'review', owner: 'sbx: stream-1', status: 'started' }] }), loose('W-2', { owner: null }), w('W-3')], c).map(x => [x.id, x]));
  assert.equal(p['W-3'].action, null, 'pinned to the busy stream, so it waits');
  assert.match(p['W-3'].reason, /busy with W-1/);
  assert.equal(p['W-2'].to, S2, 'unbound work goes to the free stream');
});

test('a factory record is the board developer\'s, never stream work', () => {
  const p = plan([loose('W-1', { kind: 'factory', owner: 'triage board worker' })]);
  assert.equal(p['W-1'].action, null);
  assert.match(p['W-1'].reason, /board developer/);
});

test('a record waiting on Alex holds no stream, so queued work can start there', () => {
  const p = plan([w('W-1', { phase: 'fixes', openQuestions: 2 }), w('W-2')]);
  assert.equal(p['W-2'].action, 'queue');
});

test('a worker stuck on a named blocker frees its stream for unblocked work; an unnamed block still holds it', () => {
  const stuck = waitingOn => w('W-1', { phase: 'implementation', assignments: [{ id: 'R1', kind: 'implementation', owner: S1, status: 'blocked', waitingOn }] });
  assert.equal(plan([stuck('TB-9'), w('W-2')])['W-2'].to, S1, 'parked on TB-9: the stream takes the next record');
  assert.equal(plan([stuck(null), w('W-2')])['W-2'].action, null, 'blocked with nothing named: still holds the stream');
});

test('a parked assignment resumes on its own stream once its blocker clears and the stream is free', () => {
  const parked = cleared => w('W-1', { phase: 'implementation', parked: [{ assignmentId: 'R1', waitingOn: 'W-5', cleared }], assignments: [{ id: 'R1', kind: 'implementation', owner: S1, status: 'blocked', waitingOn: 'W-5' }] });
  assert.deepEqual(['action', 'to', 'assignmentId'].map(k => plan([parked(true)])['W-1']?.[k]), ['resume', S1, 'R1']);
  assert.equal(plan([parked(false)])['W-1'], undefined, 'still waiting: nothing planned');
  assert.equal(plan([parked(true), w('W-3', { phase: 'implementation', assignments: [{ id: 'R1', kind: 'implementation', owner: S1, status: 'started' }] })])['W-1'].action, null, 'stream busy: waits its turn');
});
