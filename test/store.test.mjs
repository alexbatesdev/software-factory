import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../core/store.mjs';

const ctx = (over = {}) => ({ now: '2026-10-30T12:00:00.000Z', by: 'test', ...over });
const build = { kind: 'create', payload: { title: 'Fix the thing', kind: 'build', criteria: ['Thing is fixed'] } };
const ev = (target, payload, eventId) => ({ kind: 'event', target, payload, eventId });

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
  const before = structuredClone(s.state);
  assert.throws(() => s.append(ev(id, { type: 'transition', to: 'ready' }), ctx({ openQuestions: 1 })), /open question/);
  assert.equal(s.rows().length, 1);
  assert.deepEqual(s.state, before);
});

test('replay uses the observations stored on the row, not live data', () => {
  const s = openStore();
  const { id } = s.append(build, ctx());
  s.append({ kind: 'observe_head', target: id, payload: { sha: 'abc1234', via: 'github', isDraft: true } }, ctx({ standingWaiver: { by: 'Alex' }, liveOnly: 'dropped' }));
  assert.deepEqual(s.rows()[1].ctx, { now: '2026-10-30T12:00:00.000Z', by: 'test', standingWaiver: { by: 'Alex' } });
  assert.deepEqual(s.replay(), s.state);
});
