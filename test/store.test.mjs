import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../core/store.mjs';
import { headCommands } from '../core/observe.mjs';

const ctx = (over = {}) => ({ now: '2026-10-30T12:00:00.000Z', by: 'test', ...over });
const build = { kind: 'create', payload: { title: 'Fix the thing', kind: 'build', criteria: ['Thing is fixed'] } };
const ev = (target, payload, eventId) => ({ kind: 'event', target, payload, eventId });
const ask = (s, work) => s.append({ kind: 'import', target: `questions/TB-${work}`, payload: { title: 'Which?', status: 'open', work } }, ctx());

test('a reopened store replays to the state it decided, including spawned records', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sf-store-')), 'factory.db');
  const s = openStore(path);
  const { id } = s.append(build, ctx());
  for (const to of ['ready', 'queued', 'implementation']) s.append(ev(id, { type: 'transition', to, owner: 'sbx: stream-1' }), ctx());
  s.append(ev(id, { type: 'discovery', text: 'Out of scope thing' }), ctx({ now: '2026-10-30T12:05:00.000Z' }));
  s.append(ev(id, { type: 'implementation_done', head: 'abc1234' }), ctx());
  const decided = structuredClone(s.state);
  s.close();

  const again = openStore(path);
  assert.deepEqual(again.state, decided);
  assert.deepEqual(Object.keys(again.state.work), ['W-1', 'W-2']);
  assert.equal(again.state.work['W-2'].proposedFrom, 'W-1');
});

test('a repeated event id is applied once', () => {
  const s = openStore();
  const { id } = s.append(build, ctx());
  s.append(ev(id, { type: 'note', text: 'hello' }, 'evt-1'), ctx());
  assert.equal(s.append(ev(id, { type: 'note', text: 'hello' }, 'evt-1'), ctx()).duplicate, true);
  assert.equal(s.rows().length, 2);
});

test('a refused command writes nothing', () => {
  const s = openStore();
  const { id } = s.append(build, ctx());
  ask(s, id);
  const before = structuredClone(s.state);
  assert.throws(() => s.append(ev(id, { type: 'transition', to: 'ready' }), ctx()), /open question/);
  assert.equal(s.rows().length, 2);
  assert.deepEqual(s.state, before);
});

test('replay uses the observations stored on the row, not live data', () => {
  const s = openStore();
  const { id } = s.append(build, ctx());
  s.append({ kind: 'observe_head', target: id, payload: { sha: 'abc1234', via: 'github', isDraft: true } }, ctx({ standingWaiver: { by: 'Alex' }, liveOnly: 'dropped' }));
  assert.deepEqual(s.rows()[1].ctx, { now: '2026-10-30T12:00:00.000Z', by: 'test', standingWaiver: { by: 'Alex' } });
  assert.deepEqual(s.replay(), s.state);
});

test("a poll command's own observations reach the reducer: a new commit on a ready PR keeps the standing waiver", () => {
  const s = openStore(), pr = 'https://github.com/builtapp/built-rails/pull/8236';
  const { id } = s.append({ kind: 'create', payload: { title: 'PED', kind: 'build', criteria: ['x'], links: { pr } } }, ctx());
  const w = { ...s.state.work[id], phase: 'awaiting_human_approval', head: 'aaa1111', headVerified: { via: 'github', sha: 'aaa1111' },
    approvalWait: { head: 'aaa1111', prUrl: pr }, internalReviewWaivers: [{ head: 'aaa1111', prUrl: pr }] };
  s.append({ kind: 'import', target: `work/${id}`, payload: w }, ctx());
  const cmds = headCommands(s.state, new Map([['built-rails:8236', { sha: 'bbb2222', isDraft: false }]]),
    { owner: 'builtapp', now: '2026-11-04T18:21:33.000Z', standingWaiver: { by: 'Alex', reason: 'ready', authorization: 'standing' } });
  s.appendAll(cmds, ctx({ by: 'github' }));
  assert.deepEqual([s.state.work[id].phase, s.state.work[id].approvalWait?.head], ['awaiting_human_approval', 'bbb2222']);
  assert.deepEqual(s.replay().work[id].phase, 'awaiting_human_approval');
});

test("one record's question count never demotes another ready record", () => {
  const s = openStore();
  const a = s.append(build, ctx()).id;
  for (const p of [{ type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' }, { type: 'transition', to: 'implementation', owner: 'sbx: stream-1' },
    { type: 'implementation_done', head: 'aaa1111' }, { type: 'review', head: 'aaa1111', by: 'reviewer', result: 'clean' },
    { type: 'check', name: 'suite', head: 'aaa1111', result: 'pass' }, { type: 'criterion', criterionId: 'C1', accepted: true, head: 'aaa1111' }]) s.append(ev(a, p), ctx());
  if (s.state.work[a].phase !== 'ready_for_human') s.append(ev(a, { type: 'mark_ready' }), ctx());
  assert.equal(s.state.work[a].phase, 'ready_for_human');
  const b = s.append(build, ctx()).id;
  ask(s, b);
  s.append(ev(b, { type: 'note', text: 'x' }), ctx());
  assert.equal(s.state.work[a].phase, 'ready_for_human');
});

test('a message stays open until the seat it is addressed to acks it', () => {
  const s = openStore();
  const { id } = s.append({ kind: 'message', payload: { to: 'sup: stream-1', work: 'W-1', about: { requests: ['W-1/R1'] }, text: 'R1 is queued' } }, ctx({ by: 'board' }));
  assert.equal(id, 'M-1');
  assert.throws(() => s.append({ kind: 'ack_message', target: id }, ctx({ by: 'local-head' })), /only that seat/);
  s.append({ kind: 'ack_message', target: id, payload: { outcome: 'received' } }, ctx({ by: 'sup: stream-1' }));
  assert.equal(s.state.messages[id].ackedBy, 'sup: stream-1');
  assert.deepEqual(s.replay(), s.state);
});

test('commands appended together land together or not at all', () => {
  const s = openStore();
  const { id } = s.append(build, ctx());
  assert.throws(() => s.appendAll([ev(id, { type: 'note', text: 'first' }), ev(id, { type: 'transition', to: 'done' })], ctx()), /done/);
  assert.equal(s.rows().length, 1);
  assert.equal(s.state.work[id].updates.length, 1);
});

test('a question asked on ready work sends it back to re-review', () => {
  const s = openStore();
  const a = s.append(build, ctx()).id;
  for (const p of [{ type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' }, { type: 'transition', to: 'implementation', owner: 'sbx: stream-1' },
    { type: 'implementation_done', head: 'aaa1111' }, { type: 'review', head: 'aaa1111', by: 'reviewer', result: 'clean' },
    { type: 'check', name: 'suite', head: 'aaa1111', result: 'pass' }, { type: 'criterion', criterionId: 'C1', accepted: true, head: 'aaa1111' }]) s.append(ev(a, p), ctx());
  if (s.state.work[a].phase !== 'ready_for_human') s.append(ev(a, { type: 'mark_ready' }), ctx());
  s.append({ kind: 'ask', payload: { title: 'Wait, which way?', work: a } }, ctx({ by: 'sup: stream-1' }));
  assert.equal(s.state.work[a].phase, 'rereview');
});

test('a replay gives records the streams they were decided with, whatever the config says now', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'sf-store-')), 'factory.db');
  const s = openStore(path, { supervisors: ['sup: old'] });
  const { id } = s.append(build, ctx());
  s.append({ kind: 'update', target: id, payload: { owner: 'sup: old' } }, ctx());
  s.close();
  assert.equal(openStore(path, { supervisors: [] }).state.work[id].stream, 'sup: old');
});

test('acking a request closes the message that told the seat about it, so no wake follows', () => {
  const s = openStore();
  const { id } = s.append(build, ctx());
  for (const to of ['ready', 'queued']) s.append(ev(id, { type: 'transition', to }), ctx());
  const m = s.append({ kind: 'message', payload: { to: 'sup: stream-1', work: id, about: { requests: `${id}/R1` }, text: 'R1 is queued' } }, ctx({ by: 'board' })).id;
  s.append(ev(id, { type: 'ack', requestId: 'R1', outcome: 'received', by: 'sup: stream-1' }), ctx({ by: 'sup: stream-1' }));
  assert.equal(s.state.messages[m].ackedBy, 'sup: stream-1');
  assert.deepEqual(s.replay(), s.state);
});

test('a new record cannot link a PR another record already carries', () => {
  const s = openStore();
  const pr = 'https://github.com/builtforteams/built-rails/pull/8301';
  s.append({ kind: 'create', payload: { title: 'Poller record', links: { pr } } }, ctx());
  assert.throws(() => s.append({ kind: 'create', payload: { title: 'Manual record', links: { pr } } }, ctx()), /already belongs to W-1/);
  assert.deepEqual(Object.keys(s.state.work), ['W-1']);
});

test('triage moves an intake record to ready, or to clarification while a question is open', async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const s = openStore();
  const a = s.append(build, ctx()).id, b = s.append(build, ctx()).id;
  ask(s, b);
  s.appendAll(commandsFor('triage', { work: a, bucket: 'ready', note: 'clear ACs' }), ctx({ by: 'board lead' }));
  s.appendAll(commandsFor('triage', { work: b, bucket: 'ready', note: 'clear ACs' }), ctx({ by: 'board lead' }));
  assert.deepEqual([s.state.work[a].phase, s.state.work[b].phase], ['ready', 'clarification']);
  assert.match(s.state.work[a].updates.at(-1).text, /Triaged ready by board lead: clear ACs/);
  assert.throws(() => commandsFor('triage', { work: a, bucket: 'queued' }), /ready, clarify or intake/);
});

test('a review that finishes after a fixes round opened still lands, and the record stays in fixes', () => {
  const s = openStore();
  const { id } = s.append(build, ctx());
  for (const to of ['ready', 'queued', 'implementation']) s.append(ev(id, { type: 'transition', to, owner: 'sbx: stream-1' }), ctx());
  s.append(ev(id, { type: 'implementation_done', head: 'aaa1111' }), ctx());
  s.append({ kind: 'observe_health', target: id, payload: { head: 'aaa1111', conflict: true } }, ctx({ by: 'github' }));
  assert.equal(s.state.work[id].phase, 'fixes');
  s.append(ev(id, { type: 'review', head: 'aaa1111', by: 'sbx: stream-1 internal-review', result: 'clean' }), ctx());
  assert.equal(s.state.work[id].reviews.at(-1).result, 'clean');
  assert.equal(s.state.work[id].phase, 'fixes');
});

test("absorb folds a poller's duplicate PR record into the record that built the PR", async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const { sourceIndex } = await import('../core/correlate.mjs');
  const s = openStore();
  const pr = 'https://github.com/builtforteams/built-rails/pull/8487';
  const builder = s.append({ kind: 'create', payload: { title: 'Upgrade rubyzip', links: { pr } } }, ctx()).id;
  const dup = s.append({ kind: 'import', target: 'work/W-9', payload: { id: 'W-9', title: 'PR 8487', phase: 'intake', kind: 'pr-feedback', owner: 'sup: other', source: { type: 'pr', key: 'built-rails-8487' }, links: { pr }, assignments: [], requests: [], updates: [], aliases: [], reviews: [], findings: [], checks: [] } }, ctx()).id;
  s.appendAll(commandsFor('absorb', { work: 'W-9', into: builder }), ctx({ by: 'triage board worker' }));
  assert.equal(s.state.work['W-9'].phase, 'cancelled');
  assert.equal(sourceIndex(s.state).get('built-rails-8487'), builder);
  assert.ok(dup);
});

test("a review assignment leaves the record's owner as its supervisor", () => {
  const s = openStore();
  const { id } = s.append(build, ctx());
  for (const to of ['ready', 'queued', 'implementation']) s.append(ev(id, { type: 'transition', to, owner: 'sup: stream-1' }), ctx());
  s.append(ev(id, { type: 'implementation_done', head: 'aaa1111' }), ctx());
  s.append(ev(id, { type: 'assign', assignmentId: 'R2', kind: 'review', owner: 'sbx: stream-1', status: 'started', evidence: 'internal review' }), ctx({ by: 'sup: stream-1' }));
  assert.equal(s.state.work[id].owner, 'sup: stream-1');
});

test('a triaged record shows its verdict, and a factory record waits on the board developer', async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const { boardView } = await import('../views/board.mjs');
  const s = openStore();
  const f = s.append({ kind: 'create', payload: { title: 'Board bug', kind: 'factory' } }, ctx()).id;
  s.appendAll(commandsFor('triage', { work: f, bucket: 'ready', note: 'clear' }), ctx({ by: 'board lead' }));
  const [card] = boardView(s.state, { supervisors: ['sup: stream-1'] });
  assert.equal(card.category, 'ready');
  assert.deepEqual([card.waiting.who, card.waiting.text], ['triage board worker', 'Waiting on the board developer (triage board worker) to fix it']);
});

test('resolve closes a factory record, or a manual one with no criteria, with a note; never PR work', async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const s = openStore();
  const f = s.append({ kind: 'create', payload: { title: 'Board bug', kind: 'factory' } }, ctx()).id;
  const m = s.append({ kind: 'create', payload: { title: 'Guard script', kind: 'manual' } }, ctx()).id;
  const p = s.append({ ...build, payload: { ...build.payload, links: { pr: 'https://github.com/o/r/pull/1' } } }, ctx()).id;
  s.appendAll(commandsFor('resolve', { work: f, note: 'fixed in abc1234' }), ctx({ by: 'triage board worker' }));
  s.appendAll(commandsFor('resolve', { work: m, note: 'done by hand (Alex)' }), ctx({ by: 'triage board worker' }));
  assert.deepEqual([s.state.work[f].phase, s.state.work[m].phase], ['done', 'done']);
  assert.match(s.state.work[f].completion.note, /abc1234/);
  assert.throws(() => s.appendAll(commandsFor('resolve', { work: p, note: 'x' }), ctx()), /PR work/);
});

test('triage takes a proposed record too, and a record triaged to intake shows as parked with its note', async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const { boardView } = await import('../views/board.mjs');
  const s = openStore();
  const p = s.append({ kind: 'create', payload: { title: 'A discovery', phase: 'proposed' } }, ctx()).id;
  const q = s.append(build, ctx()).id;
  s.appendAll(commandsFor('triage', { work: p, bucket: 'ready', note: 'clear follow-up' }), ctx({ by: 'board lead' }));
  s.appendAll(commandsFor('triage', { work: q, bucket: 'intake', note: 'tracked on W-9' }), ctx({ by: 'board lead' }));
  assert.equal(s.state.work[p].phase, 'ready');
  const card = boardView(s.state, { supervisors: [] }).find(c => c.id === q);
  assert.equal(card.category, 'parked');
  assert.equal(card.waiting.text, 'Parked by board lead: tracked on W-9');
});

test('a finished record is history even if it was once held out of triage', async () => {
  const { categoryOf } = await import('../views/category.mjs');
  assert.equal(categoryOf({ rec: { intakeHold: { by: 'x', reason: 'y' } }, work: { id: 'W-1', phase: 'done' } }).category, 'history');
});

test("verify lets an unverified question reach Alex, or drops it with a note", async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const { reachesAlex } = await import('../core/derive.mjs');
  const s = openStore();
  const { id } = s.append(build, ctx());
  for (const [q, v] of [['TB-1', 'unverified'], ['TB-2', 'unverified']]) s.append({ kind: 'import', target: `questions/${q}`, payload: { title: 'Which?', status: 'open', work: id, verification: v } }, ctx('import'));
  s.appendAll(commandsFor('verify', { id: 'TB-1', keep: true, note: 'real product question' }), ctx({ by: 'board lead' }));
  s.appendAll(commandsFor('verify', { id: 'TB-2', keep: false, note: 'duplicate of TB-9' }), ctx({ by: 'board lead' }));
  assert.equal(reachesAlex(s.state.questions['TB-1']), true);
  assert.deepEqual([s.state.questions['TB-2'].status, s.state.questions['TB-2'].verificationNote], ['superseded', 'duplicate of TB-9']);
  assert.throws(() => s.appendAll(commandsFor('verify', { id: 'TB-1', keep: true, note: 'again' }), ctx()), /already verified/);
});

test('answering the last open question moves a record out of clarification to ready, unless it waits on someone', async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const s = openStore();
  const a = s.append(build, ctx()).id, b = s.append(build, ctx()).id;
  for (const [q, w] of [['TB-1', a], ['TB-2', a], ['TB-3', b]]) s.append({ kind: 'import', target: `questions/${q}`, payload: { title: 'Which?', status: 'open', work: w, verification: 'verified', options: [{ key: 'a', text: 'A' }] } }, ctx('import'));
  for (const id of [a, b]) s.appendAll(commandsFor('triage', { work: id, bucket: 'clarify', note: 'asked' }), ctx({ by: 'board lead' }));
  s.append(ev(b, { type: 'wait', who: 'product', what: 'their call', evidence: 'TB-9' }), ctx());
  s.appendAll(commandsFor('answer', { id: 'TB-1', choice: 'a' }), ctx({ by: 'local-head' }));
  assert.equal(s.state.work[a].phase, 'clarification', 'one question still open');
  s.appendAll(commandsFor('answer', { id: 'TB-2', choice: 'a' }), ctx({ by: 'local-head' }));
  s.appendAll(commandsFor('answer', { id: 'TB-3', choice: 'a' }), ctx({ by: 'local-head' }));
  assert.deepEqual([s.state.work[a].phase, s.state.work[b].phase], ['ready', 'clarification']);
});

test('renaming a seat moves every exact use of its label (stream, owner, assignment owner, question asker) and nothing else', () => {
  const old = 'sup: stream-conf-stack', next = 'sup: stream-2';
  const s = openStore(':memory:', { supervisors: [old] });
  const { id } = s.append(build, ctx());
  s.append(ev(id, { type: 'assign', assignmentId: 'R1', kind: 'implementation', status: 'started', owner: old, evidence: 'brief' }), ctx());
  s.append({ kind: 'import', target: 'questions/TB-1', payload: { title: 'Which?', status: 'open', work: id, from: old } }, ctx());
  s.append({ kind: 'rename_seat', payload: { from: old, to: next } }, ctx());
  const w = s.state.work[id];
  assert.equal(w.stream, next);
  assert.equal(w.owner, next);
  assert.equal(w.assignments[0].owner, next);
  assert.equal(s.state.questions['TB-1'].from, next);
  assert.ok(!JSON.stringify(s.state).includes(`"${old}"`), 'no exact old label is left anywhere');
  assert.deepEqual(s.replay(), s.state);
});

test('a seat parks a record with no assignment by naming what it waits on, and the idle nudge stops counting it', async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const { planIdleOwners } = await import('../core/notifier.mjs');
  const s = openStore();
  const id = s.append({ kind: 'create', payload: { title: 'Board bug', kind: 'factory', owner: 'dev' } }, ctx()).id;
  s.append({ kind: 'update', target: id, payload: { owner: 'dev', stream: 'dev' } }, ctx());
  s.appendAll(commandsFor('progress', { work: id, waitingOn: 'Alex: role file edit', text: 'needs a tools line' }), ctx({ by: 'dev' }));
  assert.equal(s.state.work[id].waitingOn.who, 'Alex: role file edit');
  assert.deepEqual(planIdleOwners({ seats: [{ label: 'dev', status: 'idle' }], works: s.state.work, watch: { dev: { since: 0 } }, now: 1e9 }).due, []);
  s.appendAll(commandsFor('progress', { work: id, waitingOn: 'clear', text: 'Alex made the edit' }), ctx({ by: 'dev' }));
  assert.equal(s.state.work[id].waitingOn, null);
});

test('cancel closes a stuck assignment with evidence, keeping its history', async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const s = openStore();
  const { id } = s.append(build, ctx());
  s.append(ev(id, { type: 'assign', assignmentId: 'R1', kind: 'implementation', status: 'started', owner: 'trusted-review-1', evidence: 'brief' }), ctx());
  s.appendAll(commandsFor('cancel', { work: id, assignmentId: 'R1', expectedVersion: 1, evidence: 'its pane is gone' }), ctx({ by: 'triage board worker' }));
  const a = s.state.work[id].assignments[0];
  assert.deepEqual([a.status, a.history.at(-1).status], ['cancelled', 'started']);
  assert.throws(() => commandsFor('cancel', { work: id, assignmentId: 'R1' }), /evidence/);
});
