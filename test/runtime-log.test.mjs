import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { correlate, classify, createRuntimeLog } from '../core/runtime-log.mjs';

// Evolution phase 1 step 4: runtime lines a reader can join to records and seats, with outcome and duration.
const T = '2026-11-13T17:00:00.000Z';
const lines = p => readFileSync(p, 'utf8').trim().split('\n').map(l => JSON.parse(l));

test('a line names the records, assignments and seats it is about', () => {
  assert.deepEqual(correlate('retune sbx: stream-2 for W-80 R9: FAILED'), { work: ['W-80'], assignment: ['R9'], seat: ['sbx: stream-2'] });
  assert.deepEqual(correlate('message -> sup: stream-1: {"workerNote":"W-463/17"}'), { work: ['W-463'], seat: ['sup: stream-1'] });
  assert.deepEqual(correlate('audit: 0 missed'), {});
});

test("an error says whether the factory's surroundings failed or the factory itself did", () => {
  assert.equal(classify(Object.assign(new Error('Command failed: gh api'), { cmd: 'gh api graphql' })), 'environment');
  assert.equal(classify(new Error('connect ETIMEDOUT 140.82.112.6:443')), 'environment');
  assert.equal(classify(new TypeError("Cannot read properties of undefined (reading 'id')")), 'controller');
});

test('ticks log errors at once with their kind, and a summary of runs and durations each flush', () => {
  const p = join(mkdtempSync(join(tmpdir(), 'spamton-rl-')), 'runtime.jsonl');
  const rl = createRuntimeLog(p, { now: () => T });
  rl.tick('githubTick', 1200);
  rl.tick('githubTick', 800);
  rl.tick('githubTick', 3000, Object.assign(new Error('Command failed: gh'), { cmd: 'gh' }));
  rl.line('woke sup: stream-1 for W-1');
  rl.flush();
  const [err, said, sum] = lines(p);
  assert.deepEqual([err.type, err.tick, err.outcome, err.ms, err.error.kind], ['tick', 'githubTick', 'error', 3000, 'environment']);
  assert.deepEqual([said.type, said.text, said.work, said.seat], ['line', 'woke sup: stream-1 for W-1', ['W-1'], ['sup: stream-1']]);
  assert.deepEqual([sum.type, sum.tick, sum.runs, sum.errors, sum.maxMs, sum.totalMs], ['summary', 'githubTick', 3, 1, 3000, 5000]);
  rl.flush();
  assert.equal(lines(p).length, 3, 'an empty window writes nothing');
});

test('a log that cannot be written never throws into dispatch, and says so once', () => {
  const said = [];
  const rl = createRuntimeLog('/nonexistent-dir/x/runtime.jsonl', { now: () => T, warn: m => said.push(m) });
  rl.line('a'); rl.line('b'); rl.tick('t', 1, new Error('x'));
  assert.equal(said.length, 1);
  assert.equal(rl.failures(), 3);
});
