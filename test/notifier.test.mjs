import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTarget, routeOf, inferStream, eligibleRequests, planNotifications, reconcileOnStart, notificationText } from '../core/notifier.mjs';

const SUP = 'sup: stream-1 (support+sec)';
const agent = (over = {}) => ({ agent: 'claude', pane_id: 'w5:p24', label: SUP, agent_status: 'idle', interactive_ready: true, agent_session: { value: 'sess-1' }, ...over });
const T0 = Date.parse('2026-10-26T16:00:00Z');
const iso = ms => new Date(ms).toISOString();

test('a supervisor is found by its one pane label', () => {
  assert.equal(resolveTarget([agent(), agent({ pane_id: 'w9:p1', label: 'other' })], SUP).agent.pane_id, 'w5:p24');
  assert.match(resolveTarget([agent({ label: 'other' })], SUP).reason, /not running/);
  assert.match(resolveTarget([agent(), agent({ pane_id: 'w9:p1' })], SUP).reason, /Several/);
  assert.match(resolveTarget([agent({ agent: 'codex' })], SUP).reason, /not a Claude/);
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

test('a request is notified once, reminded once, and never re-sent while uncertain', () => {
  const works = { 'W-1': work() };
  const cfg = { reminderMs: 20 * 60000 };
  assert.deepEqual(planNotifications(works, {}, T0, cfg).map(x => x.key), ['W-1/R1']);
  const sent = { 'N-1': { status: 'submitted', at: iso(T0), requests: ['W-1/R1'] } };
  assert.equal(planNotifications(works, sent, T0 + 60000, cfg).length, 0, 'no resend inside the window');
  assert.deepEqual(planNotifications(works, sent, T0 + 21 * 60000, cfg).map(x => [x.key, x.reminder]), [['W-1/R1', true]]);
  const twice = { ...sent, 'N-2': { status: 'submitted', at: iso(T0 + 21 * 60000), requests: ['W-1/R1'], reminder: true } };
  assert.equal(planNotifications(works, twice, T0 + 90 * 60000, cfg).length, 0, 'one reminder only');
  const unsure = { 'N-1': { status: 'uncertain', at: iso(T0), requests: ['W-1/R1'] } };
  assert.equal(planNotifications(works, unsure, T0 + 90 * 60000, cfg).length, 0, 'uncertain is never auto-replayed');
  const failed = { 'N-1': { status: 'failed', at: iso(T0), requests: ['W-1/R1'] } };
  assert.equal(planNotifications(works, failed, T0 + 60000, cfg).length, 1, 'a send that certainly failed can go again');
});

test('a send interrupted by a restart becomes uncertain', () => {
  const n = reconcileOnStart({ 'N-1': { status: 'sending', requests: ['W-1/R1'] }, 'N-2': { status: 'submitted', requests: [] } }, iso(T0));
  assert.equal(n['N-1'].status, 'uncertain');
  assert.equal(n['N-2'].status, 'submitted');
});

test('the prompt is one labelled line with stable ids and no commands', () => {
  const t = notificationText([{ key: 'W-1/R1', type: 'dispatch', title: 'Fix it' }, { key: 'W-9/R2', type: 'review', title: 'Other' }], 'http://127.0.0.1:4747', SUP);
  assert.match(t, /^\[triage-board notifier, automated, not Alex\]/);
  assert.match(t, /W-1\/R1 dispatch/);
  assert.match(t, /W-9\/R2 review/);
  assert.match(t, /for sup: stream-1 \(support\+sec\)/);
  assert.doesNotMatch(t, /\n/);
});

test('a request reminded inside a mixed batch is never reminded again', () => {
  const works = { 'W-1': work(), 'W-2': work({ id: 'W-2', title: 'Two' }) };
  const cfg = { reminderMs: 20 * 60000 };
  const history = {
    'N-1': { status: 'submitted', at: iso(T0), requests: ['W-1/R1'] },
    'N-2': { status: 'submitted', at: iso(T0 + 21 * 60000), requests: ['W-1/R1', 'W-2/R1'], reminders: ['W-1/R1'] },
  };
  assert.deepEqual(planNotifications(works, history, T0 + 60 * 60000, cfg).map(p => [p.key, p.reminder]), [['W-2/R1', true]]);
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
  assert.deepEqual(stops(stops({}, 'done', T0).watch, 'done', T0 + 70000).due, [], 'first seen already stopped (e.g. after a restart): not a stop the board watched');
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
