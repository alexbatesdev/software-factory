import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRecycles } from '../core/recycle.mjs';
import { autoDispatchPlan } from '../core/dispatch.mjs';

const S = 'sup: s', unit = status => ({ id: 'u', supervisor: { label: S, status: 'idle' }, worker: { label: 'sbx: s', status, sandbox: 'box-1' } });
const busy = { 'W-1': { id: 'W-1', stream: S, assignments: [{ id: 'R1', kind: 'implementation', status: 'started' }] } };
const free = { 'W-1': { id: 'W-1', stream: S, assignments: [{ id: 'R1', kind: 'implementation', status: 'done' }, { id: 'R2', kind: 'fixes', status: 'queued' }] } };

test('a worker over the threshold drains its stream, and cycles only between tasks', () => {
  assert.deepEqual(planRecycles({ units: [unit('idle')], health: { u: { diskPct: 0.7 } }, works: free, supervisors: [S] }).drain.size, 0, 'under 75% nothing happens');
  const mid = planRecycles({ units: [unit('working')], health: { u: { diskPct: 0.95 } }, works: busy, supervisors: [S] });
  assert.match(mid.drain.get(S), /95%/);
  assert.deepEqual(mid.due, [], 'a running job finishes first');
  assert.deepEqual(planRecycles({ units: [unit('idle')], health: { u: { diskPct: 0.95 } }, works: free, supervisors: [S] }).due.map(d => d.unit), ['u'], 'queued work waits for the cycle');
});

test('a cycle under way, or one that failed, keeps the stream drained', () => {
  const p = planRecycles({ units: [unit('idle')], health: {}, works: free, recycling: { u: { step: 'removing', failed: 'sbx rm exited 1' } }, supervisors: [S] });
  assert.match(p.drain.get(S), /recycle failed: sbx rm exited 1/);
  assert.deepEqual(p.due, []);
});

test('auto-dispatch sends nothing to a draining stream', () => {
  const cfg = { supervisors: { [S]: { worker: 'sbx: s' }, 'sup: t': { worker: 'sbx: t' } }, exclude: [] };
  const w = { id: 'W-9', title: 'x', phase: 'ready', priority: 3, owner: S, stream: S, streamPin: { by: 't' }, openQuestions: 0, openDeps: [], externalDeps: [], requests: [], assignments: [], links: {} };
  const [p] = autoDispatchPlan([w], { ...cfg, drain: new Map([[S, 'sbx: s disk at 95%']]) });
  assert.equal(p.action, null);
  assert.match(p.reason, /disk at 95%/);
});

test('the sbx adapter reads disk use and finds work that would die with the sandbox', async () => {
  const { parseDf, parsePreflight } = await import('../hosts/sbx.mjs');
  assert.equal(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 20511312 18320000 1100000 95% /'), 0.95);
  const p = parsePreflight('/a\t0\tok\t1\n/b\t3\tok\t1\n/c\t0\tunpushed\t1\n/d\t0\tunpushed\t9\n/e\t0\treplaced\t6\n/f\t0\treplaced\t0\n');
  assert.deepEqual(p.map(x => [x.path, x.blocking]), [['/b', true], ['/c', true], ['/d', false], ['/e', false], ['/f', true]]);
});

test('only configured streams are ever drained or recycled (Mutation is Alex own)', () => {
  const mut = { id: 'm', supervisor: { label: 'sup: mutation-tester', status: 'idle' }, worker: { label: 'sbx: mutation-tester', status: 'idle', sandbox: 'box-m' } };
  const p = planRecycles({ units: [mut], health: { m: { diskPct: 0.99 } }, works: {}, supervisors: [S] });
  assert.deepEqual([p.drain.size, p.due.length], [0, 0]);
});

test("a recycled sandbox's agent starts the way the sbx plugin starts it, so herdr can see whether it is working", async () => {
  const { bridgeLine } = await import('../hosts/sbx.mjs');
  const line = await bridgeLine({ ref: 'w2G:p3' });
  assert.match(line, /HERDR_AGENT='?claude'?\s/);
  assert.match(line, /bridge\.mjs'? '?start'? /);
});
