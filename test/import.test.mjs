import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../core/store.mjs';
import { importCommands, exportV1 } from '../core/import.mjs';

const ctx = { now: '2026-10-30T15:00:00.000Z', by: 'import' };
const importAll = (s, v1) => importCommands(v1, s.state).map(c => s.append(c, ctx));
const v1 = () => ({
  schema: 2, nextWork: 3, items: { 'tw-1': { firstSeen: 'x' } },
  work: { 'W-1': { id: 'W-1', phase: 'ready_for_human', head: 'abc1234', reviews: [], updates: [] }, 'W-2': { id: 'W-2', phase: 'intake', updates: [] } },
  questions: { 'TB-1': { status: 'open', work: 'W-1' } }, notifications: { 'N-1': { to: 'sup' } },
});

test('an import exports back to the same state.json, and replays to it', () => {
  const s = openStore();
  importAll(s, v1());
  assert.deepEqual(exportV1(s.state), v1(), 'imported records are kept as V1 wrote them, never re-normalized');
  assert.deepEqual(exportV1(s.replay()), v1());
  assert.equal(s.state.nextWork, 3);
});

test('a re-import writes only what changed, including removals', () => {
  const s = openStore();
  importAll(s, v1());
  assert.equal(importCommands(v1(), s.state).length, 0);
  const next = v1(); next.work['W-2'].phase = 'ready'; delete next.notifications['N-1'];
  assert.deepEqual(importAll(s, next).map(r => r.id), ['work/W-2', 'notifications/N-1']);
  assert.deepEqual(exportV1(s.state), next);
});

// The live V1 board, when present: the round trip must be lossless on real data.
const live = join(homedir(), 'Code/triage-board/state.json');
test('the live V1 state.json round-trips', { skip: !existsSync(live) && 'no V1 board here' }, () => {
  const real = JSON.parse(readFileSync(live, 'utf8'));
  const s = openStore();
  importAll(s, real);
  assert.deepEqual(exportV1(s.replay()), real);
});
