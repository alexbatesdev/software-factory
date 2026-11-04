import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../core/store.mjs';

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
