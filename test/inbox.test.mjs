import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { inboxCommands } from '../core/inbox.mjs';

const S1 = 'sup: stream-1', R = 'questions router';
const cfg = { supervisors: [S1], seats: [S1, R, 'local-head'], router: R };
const ctx = (by = 'test') => ({ now: '2026-10-30T19:00:00.000Z', by });
const work = (over = {}) => ({ id: 'W-1', title: 'Fix it', phase: 'queued', stream: S1, head: null, requests: [{ id: 'R1', type: 'dispatch', at: 'x', ack: null }], assignments: [], updates: [], ...over });
const store = (state = {}) => {
  const s = openStore();
  for (const [c, recs] of Object.entries(state)) for (const [k, v] of Object.entries(recs)) s.append({ kind: 'import', target: `${c}/${k}`, payload: v }, ctx('import'));
  return s;
};
const plan = (s, fleet) => inboxCommands(s.state, cfg, fleet);

test('each open request is messaged to its stream once, and never again after V1 already told it', () => {
  const s = store({ work: { 'W-1': work() } });
  const [c] = plan(s).cmds;
  assert.deepEqual([c.payload.to, c.payload.about], [S1, { requests: 'W-1/R1' }]);
  s.append(c, ctx('board'));
  assert.deepEqual(plan(s).cmds, []);
  const v1 = store({ work: { 'W-1': work() }, notifications: { 'N-1': { status: 'submitted', requests: ['W-1/R1'] } } });
  assert.deepEqual(plan(v1).cmds, [], 'a V1 notice counts as told');
  const shadow = store({ work: { 'W-1': work() }, notifications: { 'N-1': { status: 'submitted', at: '2026-10-31', requests: ['W-1/R1'] } } });
  assert.equal(inboxCommands(shadow.state, { ...cfg, v1Before: '2026-10-30' }).cmds.length, 1, 'shadow decides for itself after it started');
});

test("an answer goes to the router's pick, else a seat that asked, else the record's stream, else the router", () => {
  const answered = (from, extra = {}) => ({ status: 'answered', from, work: 'W-1', answer: { choice: 'a', at: 'z', ...extra } });
  const s = store({ work: { 'W-1': work({ requests: [] }), 'W-2': work({ id: 'W-2', stream: null, requests: [] }) },
    questions: { 'TB-1': answered('local-head'), 'TB-2': answered('reaped pane'), 'TB-3': { ...answered('reaped pane'), work: 'W-2' }, 'TB-4': answered('local-head', { routeTo: S1 }) } });
  const to = Object.fromEntries(plan(s).cmds.map(c => [c.payload.about.answers, c.payload.to]));
  assert.deepEqual(to, { 'TB-1': 'local-head', 'TB-2': S1, 'TB-3': R, 'TB-4': S1 });
});

test('a worker that stops with a started assignment messages its supervisor once', () => {
  const s = store({ work: { 'W-1': work({ phase: 'implementation', requests: [], assignments: [{ id: 'R1', kind: 'implementation', status: 'started', version: 1 }] }) } });
  const unit = status => ({ id: 'u1', supervisor: { label: S1, status: 'idle' }, worker: { label: 'sbx: stream-1', status } });
  let { watches } = plan(s, { units: [unit('working')], now: 0 });
  ({ watches } = plan(s, { units: [unit('idle')], now: 1000, watches }));
  const due = plan(s, { units: [unit('idle')], now: 120000, watches });
  assert.deepEqual(due.cmds.map(c => c.payload.about), [{ workerStop: 'W-1/R1' }]);
});
