import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, routeOf, inferStream, eligibleRequests } from '../core/notifier.mjs';

const SUP = 'sup: stream-1 (support+sec)';
const agent = (over = {}) => ({ agent: 'claude', pane_id: 'w5:p24', label: SUP, agent_status: 'idle', interactive_ready: true, agent_session: { value: 'sess-1' }, ...over });
const T0 = Date.parse('2026-10-26T16:00:00Z');
const iso = ms => new Date(ms).toISOString();

test('a supervisor is found by its one pane label', () => {
  assert.equal(resolveTarget([agent(), agent({ pane_id: 'w9:p1', label: 'other' })], SUP).agent.pane_id, 'w5:p24');
  assert.match(resolveTarget([agent({ label: 'other' })], SUP).reason, /not running/);
  assert.match(resolveTarget([agent(), agent({ pane_id: 'w9:p1' })], SUP).reason, /Several/);
  assert.match(resolveTarget([agent({ agent: 'codex' })], SUP).reason, /not a claude agent/i);
});

test('busy, blocked, unknown or not interactive-ready defers', () => {
  for (const s of ['working', 'blocked', 'unknown']) assert.match(resolveTarget([agent({ agent_status: s })], SUP).defer, new RegExp(s));
  assert.match(resolveTarget([agent({ interactive_ready: false })], SUP).defer, /ready/);
  assert.equal(resolveTarget([agent({ agent_status: 'done' })], SUP).defer, undefined);
});


test('a record routes to its stream only; the stream is inferred once from its latest supervisor, never a reviewer pane', () => {
  const sups = [SUP, 'sup: stream-conf-stack'];
  const w = { owner: 'pr-8244-trusted-review', assignments: [{ owner: 'sup: stream-conf-stack' }, { owner: SUP }, { owner: 'pr-8244-trusted-review' }] };
  assert.equal(inferStream(w, sups), SUP);
  assert.equal(inferStream({ owner: 'pr-1-trusted-review', assignments: [] }, sups), null);
  assert.equal(inferStream({ owner: null, implementer: 'sup: stream-conf-stack' }, sups), 'sup: stream-conf-stack');
  assert.equal(routeOf({ ...w, stream: 'sup: stream-conf-stack' }, sups), 'sup: stream-conf-stack', 'the stream wins over any assignee');
  assert.equal(routeOf(w, sups), null, 'no stream recorded: unrouted, never guessed at send time');
  assert.equal(routeOf({ stream: 'sup: gone' }, sups), null);
});

const work = (over = {}) => ({ id: 'W-1', title: 'Fix it', phase: 'queued', head: null, requests: [{ id: 'R1', type: 'dispatch', at: iso(T0), delivery: 'written', ack: null }], ...over });

test('only current, unacked requests on live items are eligible', () => {
  assert.deepEqual(eligibleRequests({ 'W-1': work() }).map(x => `${x.work}/${x.request}`), ['W-1/R1']);
  assert.equal(eligibleRequests({ 'W-1': work({ phase: 'cancelled' }) }).length, 0, 'terminal');
  assert.equal(eligibleRequests({ 'W-1': work({ requests: [{ id: 'R1', type: 'dispatch', ack: { outcome: 'received' } }] }) }).length, 0, 'acked');
  assert.equal(eligibleRequests({ 'W-1': work({ phase: 'implementation' }) }).length, 0, 'dispatch no longer current');
  const rev = work({ phase: 'review', head: 'bbb', requests: [{ id: 'R2', type: 'review', head: 'aaa', ack: null }, { id: 'R3', type: 'review', head: 'bbb', ack: null }] });
  assert.deepEqual(eligibleRequests({ 'W-1': rev }).map(x => x.request), ['R3'], 'stale-head review skipped');
  assert.equal(eligibleRequests({ 'W-1': work({ synthetic: true }) }).length, 1, 'synthetic items are notified like any other');
});

import { planWorkerStops } from '../core/notifier.mjs';
const unit = status => ({ id: 'stream-1', supervisor: { label: SUP }, worker: { label: 'sbx: stream-1', ref: 'w5:p27', status } });
const busy = { 'W-60': { id: 'W-60', stream: SUP, phase: 'awaiting_human_approval', assignments: [{ id: 'R2', kind: 'discovery', status: 'started', version: 2 }] } };
const stops = (watch, status, now, works = busy) => planWorkerStops({ units: [unit(status)], works, watch, now, graceMs: 60000, supervisors: [SUP] });

test('a worker that stops while its stream has a started assignment wakes the supervisor once, after a grace period', () => {
  let w = stops({}, 'working', T0).watch;
  let r = stops(w, 'done', T0 + 30000); assert.deepEqual(r.due, [], 'inside the grace period: maybe between turns');
  r = stops(r.watch, 'done', T0 + 91000);
  assert.deepEqual(r.due.map(d => [d.to, d.work, d.assignment, d.worker]), [[SUP, 'W-60', 'R2', 'sbx: stream-1']]);
  r = stops(r.watch, 'idle', T0 + 120000); assert.deepEqual(r.due, [], 'one notice per stop');
  r = stops(stops(r.watch, 'working', T0 + 130000).watch, 'done', T0 + 140000);
  r = stops(r.watch, 'done', T0 + 201000); assert.equal(r.due.length, 1, 're-armed by working');
});

test('no notice while blocked, with no started assignment, for a stop the board never saw start, or outside a configured stream', () => {
  const after = (status, works, from = 'working') => { let w = stops({}, from, T0, works).watch; w = stops(w, status, T0 + 1000, works).watch; return stops(w, status, T0 + 70000, works).due; };
  assert.deepEqual(after('blocked', busy), []);
  assert.deepEqual(after('done', { 'W-60': { ...busy['W-60'], assignments: [{ id: 'R2', kind: 'discovery', status: 'done' }] } }), []);
  assert.deepEqual(after('done', { 'W-9': { id: 'W-9', stream: SUP, assignments: [{ id: 'R1', kind: 'review', owner: 'pr-1-trusted-review', status: 'started' }] } }), [], 'a review in a reviewer pane is not the worker');
  assert.equal(after('done', { 'W-9': { id: 'W-9', stream: SUP, assignments: [{ id: 'R1', kind: 'review', owner: 'sbx: stream-1', status: 'started' }] } }).length, 1, 'an internal review the worker runs counts');
  assert.deepEqual(planWorkerStops({ units: [unit('done')], works: busy, watch: { 'stream-1': { armed: true, stoppedAt: T0 } }, now: T0 + 70000, graceMs: 60000, supervisors: [] }).due, []);
});

import { planIdleQueues } from '../core/notifier.mjs';
test('a stream left idle with an acked, queued assignment wakes its supervisor once, after a grace period', () => {
  const u = (sup, wk) => [{ id: 'stream-1', supervisor: { label: SUP, status: sup }, worker: { label: 'sbx: stream-1', status: wk } }];
  const works = { 'W-82': { id: 'W-82', stream: SUP, assignments: [{ id: 'R4', kind: 'review', status: 'done' }] },
    'W-111': { id: 'W-111', stream: SUP, assignments: [{ id: 'R1', kind: 'implementation', status: 'queued', version: 1 }] } };
  const plan = (watch, sent, now, units = u('done', 'done'), w = works) => planIdleQueues({ units, works: w, watch, sent, now, graceMs: 300000, supervisors: [SUP] });
  let r = plan({}, {}, T0); assert.deepEqual(r.due, [], 'inside the grace period');
  r = plan(r.watch, {}, T0 + 301000);
  assert.deepEqual(r.due.map(d => [d.to, d.work, d.assignment, d.key]), [[SUP, 'W-111', 'R1', 'W-111/R1/v1']]);
  assert.deepEqual(plan(r.watch, { 'W-111/R1/v1': {} }, T0 + 400000).due, [], 'one notice per queued assignment');
  assert.deepEqual(plan({}, {}, T0 + 301000, u('working', 'done')).due, [], 'the supervisor is mid-turn');
  assert.deepEqual(plan(plan({}, {}, T0, u('done', 'blocked')).watch, {}, T0 + 301000, u('done', 'blocked')).due, [], 'the worker is at a dialog');
  const running = { ...works, 'W-32': { id: 'W-32', stream: SUP, assignments: [{ id: 'R3', kind: 'fixes', status: 'started' }] } };
  assert.deepEqual(plan(plan({}, {}, T0, u('done', 'done'), running).watch, {}, T0 + 301000, u('done', 'done'), running).due, [], 'the stream has started work');
  const scouting = { ...works, 'W-40': { id: 'W-40', kind: 'scout', stream: SUP, assignments: [{ id: 'R1', kind: 'discovery', status: 'started' }] } };
  assert.deepEqual(plan(plan({}, {}, T0, u('done', 'done'), scouting).watch, {}, T0 + 301000, u('done', 'done'), scouting).due.map(d => d.work), ['W-111'], 'a running scout never holds the stream');
  const parked = { ...works, 'W-32': { id: 'W-32', stream: SUP, assignments: [{ id: 'R5', kind: 'fixes', status: 'blocked' }] } };
  assert.equal(plan(plan({}, {}, T0, u('done', 'done'), parked).watch, {}, T0 + 301000, u('done', 'done'), parked).due.length, 1, 'work blocked on a person does not hold the stream');
});

test('a queued assignment says what holds its stream: started work, a busy pane, or the wake-up the board has scheduled', async () => {
  const { streamHold } = await import('../core/notifier.mjs');
  const to = 'sup: s1', u = { id: 'u1', supervisor: { label: to, status: 'idle' }, worker: { label: 'sbx: s1', status: 'idle' } };
  const works = { 'W-82': { id: 'W-82', stream: to, assignments: [{ id: 'R5', status: 'started' }] }, 'W-71': { id: 'W-71', stream: to, assignments: [{ id: 'R2', status: 'queued' }] } };
  assert.match(streamHold(u, works), /W-82 R5/);
  assert.match(streamHold({ ...u, worker: { label: 'sbx: s1', status: 'working' } }, { 'W-71': works['W-71'] }), /sbx: s1 is working/);
  assert.equal(streamHold(u, { 'W-71': works['W-71'] }), null);
});

test('a priority record queued on a free stream starts before older queued work', async () => {
  const { planIdleQueues } = await import('../core/notifier.mjs');
  const S = 'sup: s1', q = (id, priority) => ({ id, stream: S, priority, assignments: [{ id: 'R1', kind: 'implementation', status: 'queued', version: 1 }] });
  const units = [{ id: 'u1', supervisor: { label: S, status: 'idle' }, worker: { label: 'sbx: s1', status: 'idle' } }];
  const { due } = planIdleQueues({ units, works: { 'W-5': q('W-5', 3), 'W-9': q('W-9', 1) }, watch: { u1: 0 }, now: 600000, supervisors: [S] });
  assert.equal(due[0].work, 'W-9');
});

test('a worker stop names the most recently started assignment, not the newest record', async () => {
  const { planWorkerStops } = await import('../core/notifier.mjs');
  const S = 'sup: s', started = at => ({ status: 'started', at });
  const works = {
    'W-1': { id: 'W-1', stream: S, assignments: [{ id: 'R2', kind: 'review', owner: 'sbx: s', status: 'started', history: [started('2026-11-03T00:02:38Z')] }] },
    'W-2': { id: 'W-2', stream: S, assignments: [{ id: 'R1', kind: 'implementation', status: 'started', history: [started('2026-11-02T23:43:35Z')] }] },
  };
  const u = status => ({ id: 'u', supervisor: { label: S, status: 'idle' }, worker: { label: 'sbx: s', status } });
  const { watch } = planWorkerStops({ units: [u('working')], works, now: 0, supervisors: [S] });
  const a = planWorkerStops({ units: [u('idle')], works, watch, now: 0, supervisors: [S] });
  const { due } = planWorkerStops({ units: [u('idle')], works, watch: a.watch, now: 120000, supervisors: [S] });
  assert.deepEqual(due.map(d => `${d.work}/${d.assignment}`), ['W-1/R2']);
});

test('after a restart, a worker already stopped with a started assignment still messages its supervisor', async () => {
  const { planWorkerStops } = await import('../core/notifier.mjs');
  const S = 'sup: s', works = { 'W-1': { id: 'W-1', stream: S, assignments: [{ id: 'R1', kind: 'implementation', status: 'started' }] } };
  const u = { id: 'u', supervisor: { label: S, status: 'idle' }, worker: { label: 'sbx: s', status: 'idle' } };
  const a = planWorkerStops({ units: [u], works, now: 0, supervisors: [S] });
  const { due } = planWorkerStops({ units: [u], works, watch: a.watch, now: 120000, supervisors: [S] });
  assert.deepEqual(due.map(d => d.work), ['W-1']);
});

test('every automated notice a seat receives carries the one factory prefix', async () => {
  const { wakeText } = await import('../core/wake.mjs');
  const { PREFIX } = await import('../core/notifier.mjs');
  assert.ok(wakeText({ seat: 's', ids: ['M-1'], reminder: false }).startsWith(`${PREFIX} `));
});

test('an idle seat that owns open records is pestered after a grace period, then again every repeat, until it works', async () => {
  const { planIdleOwners } = await import('../core/notifier.mjs');
  const works = { 'W-9': { id: 'W-9', title: 'Fix the poller', phase: 'ready', stream: 'dev' }, 'W-3': { id: 'W-3', title: 'Old', phase: 'done', stream: 'dev' },
    'W-5': { id: 'W-5', title: 'Held', phase: 'ready', stream: 'dev', waitingOn: 'TB-1' } };
  const seat = status => [{ label: 'dev', status }];
  const run = (watch, status, now) => planIdleOwners({ seats: seat(status), works, watch, now, graceMs: 600000, repeatMs: 1800000 });
  let r = run({}, 'idle', T0); assert.deepEqual(r.due, [], 'just went idle');
  r = run(r.watch, 'idle', T0 + 600000); assert.deepEqual(r.due.map(d => [d.to, d.work, d.count]), [['dev', 'W-9', 1]]);
  r = run(r.watch, 'idle', T0 + 900000); assert.deepEqual(r.due, [], 'no repeat inside the repeat window');
  r = run(r.watch, 'done', T0 + 2400000); assert.equal(r.due.length, 1, 'pestered again');
  r = run(r.watch, 'working', T0 + 2500000); assert.deepEqual([r.due, r.watch], [[], {}], 'working clears the watch');
  assert.deepEqual(planIdleOwners({ seats: seat('idle'), works: { 'W-3': works['W-3'] }, watch: {}, now: T0 }).due, [], 'nothing open, nothing to say');
});

test('a host stream with no paired worker is woken when the worker its started job names stops', () => {
  const host = { id: 'host', supervisor: { label: 'sup: host' }, worker: null };
  const works = { 'W-234': { id: 'W-234', stream: 'sup: host', assignments: [{ id: 'R2', kind: 'review', owner: 'w234-create-task', status: 'started' }] } };
  const others = [{ label: 'w234-create-task', ref: 'w31:p1', status: 'done' }];
  const r = planWorkerStops({ units: [host], others, works, watch: { host: { armed: true, stoppedAt: T0 } }, now: T0 + 70000, graceMs: 60000, supervisors: ['sup: host'] });
  assert.deepEqual(r.due.map(d => [d.to, d.work, d.assignment, d.worker]), [['sup: host', 'W-234', 'R2', 'w234-create-task']]);
});

test("a codex worker's pane can be woken when its seat runs codex, and nowhere else", () => {
  const W = 'sbx: stream-2', codex = agent({ agent: 'codex', label: W });
  assert.equal(resolveTarget([codex], W, 'codex').ok, true);
  assert.match(resolveTarget([codex], W).reason, /not a claude agent/i);
  assert.match(resolveTarget([agent({ label: W })], W, 'codex').reason, /not a codex agent/i);
});

test("a host worker whose job still names the supervisor as owner is found in the supervisor's workspace, so its stop still wakes it (W-362: W-354 R1)", () => {
  const T = 1_000_000;
  const host = { id: 'host', supervisor: { label: 'sup: host', workspace: 'Host' }, worker: null };
  const works = { 'W-354': { id: 'W-354', stream: 'sup: host', assignments: [{ id: 'R1', kind: 'implementation', owner: 'sup: host', status: 'started' }] } };
  const others = [{ label: 'tw-41503361-osup-req-submit', status: 'done', workspace: 'Host' }, { label: 'board lead', status: 'idle', workspace: 'Services' }];
  const r = planWorkerStops({ units: [host], others, works, watch: { host: { armed: true, stoppedAt: T } }, now: T + 70000, graceMs: 60000, supervisors: ['sup: host'] });
  assert.deepEqual(r.due.map(d => [d.to, d.work, d.assignment, d.worker]), [['sup: host', 'W-354', 'R1', 'tw-41503361-osup-req-submit']]);
  const two = [...others, { label: 'tw-other', status: 'working', workspace: 'Host' }];
  assert.deepEqual(planWorkerStops({ units: [host], others: two, works, watch: { host: { armed: true, stoppedAt: T } }, now: T + 70000, graceMs: 60000, supervisors: ['sup: host'] }).due, [], 'two candidates: no guess');
});
