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
