import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { boardView } from '../views/board.mjs';

const S1 = 'sup: stream-1';
const ctx = (by = 'test') => ({ now: '2026-10-30T22:00:00.000Z', by });
const card = (s, id) => boardView(s.state, { supervisors: [S1] }).find(c => c.id === id);

test('an answer delivered as a message waits on its seat until acked (row 14)', () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  s.append({ kind: 'update', target: 'W-1', payload: { owner: S1 } }, ctx());
  s.appendAll([{ kind: 'ask', payload: { title: 'Q', options: [{ key: 'a', text: 'a' }], work: 'W-1' } }, { kind: 'answer', target: 'TB-1', payload: { choice: 'a' } }], ctx());
  const { id } = s.append({ kind: 'message', payload: { to: S1, work: 'W-1', about: { answers: 'TB-1' }, text: 'Answer to TB-1: (a)' } }, ctx('board'));
  assert.match(card(s, 'W-1').waiting.text, /your answer to TB-1 was delivered but not acknowledged/);
  s.append({ kind: 'ack_message', target: id }, ctx(S1));
  assert.doesNotMatch(card(s, 'W-1').waiting?.text || '', /TB-1/);
});

test("a worker-stop message shows on the record until the supervisor acts", () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  s.appendAll([{ kind: 'update', target: 'W-1', payload: { owner: S1 } }, ...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
    { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'started', owner: S1, evidence: 'brief' } }], ctx());
  const a = s.state.work['W-1'].assignments.find(x => x.status === 'started');
  s.append({ kind: 'message', payload: { to: S1, work: 'W-1', about: { workerStop: `W-1/${a.id}` }, text: 'worker stopped' } }, ctx('board'));
  assert.match(card(s, 'W-1').waiting.text, new RegExp(`Worker finished; ${S1} notified`));
});

const started = () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  s.appendAll([{ kind: 'update', target: 'W-1', payload: { owner: S1 } }, ...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
    { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'started', owner: S1, evidence: 'brief' } }], ctx());
  return s;
};
const unit = (sup = 'idle', worker = 'working') => ({ id: 'u1', supervisor: { label: S1, status: sup }, worker: { label: 'sbx: stream-1', status: worker } });

test("a stream pane stuck at a prompt puts the record in front of Alex", () => {
  const s = started();
  const c = boardView(s.state, { supervisors: [S1], units: [unit('idle', 'blocked')] }).find(x => x.id === 'W-1');
  assert.match(c.waiting.text, /sbx: stream-1 is waiting at a prompt/);
  assert.equal(c.needs.me, true);
});

test('queued work on a free stream says when the board will wake its supervisor', () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  s.appendAll([{ kind: 'update', target: 'W-1', payload: { owner: S1 } }, ...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
    { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'queued', owner: S1, evidence: 'brief' } }], ctx());
  const since = new Date('2026-10-30T22:00:00').getTime();
  const c = boardView(s.state, { supervisors: [S1], units: [unit('idle', 'idle')], idleSince: { u1: since }, graceMs: 300000 }).find(x => x.id === 'W-1');
  assert.match(c.waiting.text, /stream free; the board wakes sup: stream-1 at 22:05/);
});

test('a worker-stop notice clears once the assignment moves on, and the newest stop wins', () => {
  const s = started();
  const a = s.state.work['W-1'].assignments.find(x => x.status === 'started');
  s.append({ kind: 'message', payload: { to: S1, work: 'W-1', about: { workerStop: 'W-1/R1' }, text: 'old stop' } }, ctx('board'));
  s.append({ kind: 'message', payload: { to: S1, work: 'W-1', about: { workerStop: `W-1/${a.id}` }, text: 'stop' } }, ctx('board'));
  assert.match(card(s, 'W-1').waiting.text, /Worker finished/, 'an older, stale stop message does not hide the current one');
  s.append({ kind: 'event', target: 'W-1', payload: { type: 'progress', assignmentId: a.id, expectedVersion: a.version, stage: 'working', text: 'still going' } }, { now: '2026-10-30T22:10:00.000Z', by: S1 });
  assert.doesNotMatch(card(s, 'W-1').waiting?.text || '', /Worker finished/);
});

test("a record with no stream never takes another pane's prompt as its own", () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'Mutation run' } }, ctx());
  s.appendAll([...['ready', 'queued'].map(to => ({ kind: 'event', target: 'W-1', payload: { type: 'transition', to } })),
    { kind: 'event', target: 'W-1', payload: { type: 'assign', assignmentId: 'R2', kind: 'implementation', status: 'started', owner: 'mutation tester', evidence: 'x' } }], ctx());
  const orphan = { id: 'u9', supervisor: null, worker: { label: 'sbx: orphan', status: 'blocked' } };
  const c = boardView(s.state, { supervisors: [S1], units: [orphan] }).find(x => x.id === 'W-1');
  assert.doesNotMatch(c.waiting?.text || '', /waiting at a prompt/);
});

test("a ready record's waiting line and queue position come from the auto-dispatch plan", async () => {
  const { openStore } = await import('../core/store.mjs');
  const { boardView } = await import('../views/board.mjs');
  const s = openStore(), ctx = { now: '2026-11-04T12:00:00.000Z', by: 'test' };
  const ids = ['A', 'B', 'M'].map(t => s.append({ kind: 'create', payload: { title: t } }, ctx).id);
  const queue = [{ id: ids[0], action: null, reason: 'every stream is busy; waits its turn' }, { id: ids[2], action: null, reason: 'Excluded in config.autoDispatch.exclude' }, { id: ids[1], action: null, reason: 'every stream is busy; waits its turn' }];
  const cards = Object.fromEntries(boardView(s.state, { queue }).map(c => [c.id, c]));
  assert.equal(cards[ids[1]].waiting.text, 'In queue, #2: the next free stream takes #1');
  assert.equal(cards[ids[2]].waiting.text, 'Not dispatched: Excluded in config.autoDispatch.exclude');
});

test('a card shows what the exit report says is unverified, and nothing when it says nothing', () => {
  const s = openStore(':memory:', { supervisors: [S1] });
  s.append({ kind: 'create', payload: { title: 'T' } }, ctx());
  const report = unverified => s.append({ kind: 'event', target: 'W-1', payload: { type: 'note', text: `Exit report. Changed: a. Proven: b. Unverified: ${unverified} Risk: low.` } }, ctx());
  report('The live GitHub call.');
  assert.equal(card(s, 'W-1').unverified, 'The live GitHub call.');
  report('nothing.');
  assert.equal(card(s, 'W-1').unverified, null);
});

test('a record held on an open question waits on Alex, not in Parked', async () => {
  const { openStore } = await import('../core/store.mjs');
  const s = openStore(':memory:'), c = { now: '2026-11-09T21:00:00.000Z', by: 'test' };
  s.append({ kind: 'create', payload: { title: 'Decide the rule' } }, c);
  s.append({ kind: 'ask', payload: { title: 'Read access on every req?', options: [], work: 'W-1', wwbd: 'none' } }, { ...c, by: 'sup: stream-1' });
  s.append({ kind: 'create', payload: { title: 'Five more mutations' } }, c);
  s.append({ kind: 'sync_intake', target: 'W-2', payload: { bucket: 'intake', note: 'Held on TB-1' } }, c);
  s.append({ kind: 'event', target: 'W-2', payload: { type: 'hold', questions: ['TB-1'] } }, c);
  const card = boardView(s.state).find(x => x.id === 'W-2');
  assert.equal(card.heldOn, 'TB-1');
  assert.deepEqual(card.waiting, { who: 'you', text: 'Waiting on you: TB-1 (Read access on every req?)' });
});

test("a card shows the record's real wait: Alex's actions are his, never masked by the queue's reason (audit 11-09)", async () => {
  const { openStore } = await import('../core/store.mjs');
  const s = openStore(':memory:'), c = { now: '2026-11-09T22:00:00.000Z', by: 'test' };
  const make = (title, extra = {}) => s.append({ kind: 'create', payload: { title, kind: 'build', ...extra } }, c).id;
  const prOk = make('New PR nobody asked for', { source: { type: 'manual' } });
  s.append({ kind: 'event', target: prOk, payload: { type: 'transition', to: 'ready' } }, c);
  const script = make('Waits on Alex running a script');
  s.append({ kind: 'event', target: script, payload: { type: 'wait', who: 'Alex runs ~/Code/plans/x.sh', what: 'role-file edits', evidence: 'x' } }, c);
  const held = make('Held on two merges');
  s.append({ kind: 'sync_intake', target: held, payload: { bucket: 'intake', note: 'Held until #1 merges' } }, c);
  s.append({ kind: 'event', target: held, payload: { type: 'hold', prs: ['#1'] } }, c);
  const mine = make('A role-file edit the board developer owns', { source: { type: 'manual' } });
  s.append({ kind: 'update', target: mine, payload: { owner: 'triage board worker' } }, c);
  s.append({ kind: 'event', target: mine, payload: { type: 'transition', to: 'ready' } }, c);
  const queue = [prOk, script].map(id => ({ id, action: null, reason: 'a reason from the queue' }));
  const v = Object.fromEntries(boardView(s.state, { queue, prApproval: { trusted: ['teamwork'] } }).map(x => [x.id, x]));
  assert.deepEqual(v[prOk].waiting, { who: 'you', text: 'Waiting on you: approve opening a new PR (Approvals, New PRs)' });
  assert.deepEqual(v[script].waiting, { who: 'you', text: 'Waiting on you: role-file edits (Alex runs ~/Code/plans/x.sh)' });
  assert.deepEqual(v[held].waiting, { who: null, text: 'Held until #1 merges' });
  assert.notEqual(v[mine].waiting?.who, 'you', 'work a non-stream seat owns never dispatches, so it needs no new-PR click');
});

test("a ready PR's card says what it really waits on: Alex's thread clicks, missing GitHub approvals, or his final checks (APPROVED is not Built's QA gate)", async () => {
  const { openStore } = await import('../core/store.mjs');
  const s = openStore(':memory:'), c = { now: '2026-11-09T22:00:00.000Z', by: 'test' }, PR = 'https://github.com/o/r/pull/7';
  const id = s.append({ kind: 'create', payload: { title: 'Ready PR', links: { pr: PR } } }, c).id;
  s.state.work[id].phase = 'awaiting_human_approval';
  const view = (prs, threads = {}) => { s.state.threads = threads; return boardView(s.state, { prs: new Map([[PR, prs]]) }).find(x => x.id === id).waiting; };
  assert.deepEqual(view({ reviewDecision: 'REVIEW_REQUIRED', approvedBy: ['qa-pat'] }), { who: 'reviewers', text: 'Waiting for approvals on #7 (approved so far: qa-pat)' });
  assert.deepEqual(view({ reviewDecision: 'APPROVED', approvedBy: ['qa-pat', 'dev-sam'] }), { who: 'you', text: 'Waiting on you: GitHub reviews approved on #7 (qa-pat, dev-sam); final QA and merge checks need you' });
  assert.deepEqual(view({ reviewDecision: 'APPROVED', approvedBy: ['qa-pat', 'dev-sam'] }, { 'RT-1': { work: id, status: 'requested' }, 'RT-2': { work: id, status: 'resolved' } }),
    { who: 'you', text: 'Waiting on you: resolve 1 review thread (Approvals, Review threads)' });
});

test('a parked record whose PR is open and ready waits on its reviewers, not in Parked (W-106: built-architecture #72)', async () => {
  const { openStore } = await import('../core/store.mjs');
  const s = openStore(':memory:'), c = { now: '2026-11-09T22:00:00.000Z', by: 'test' }, PR = 'https://github.com/o/r/pull/72';
  const id = s.append({ kind: 'create', payload: { title: 'Dev DB S3', links: { pr: PR } } }, c).id;
  s.append({ kind: 'sync_intake', target: id, payload: { bucket: 'intake', note: 'Open #72, nothing for the factory' } }, c);
  const v = boardView(s.state, { prs: new Map([[PR, { state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', approvedBy: [] }]]) }).find(x => x.id === id);
  assert.deepEqual(v.waiting, { who: 'reviewers', text: 'Waiting for approvals on #72' });
});
