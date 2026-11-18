// W-561: tokens and cost per job, read from the agents' own session logs. Neutral fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { activeWindows, costOf, usageDue } from '../core/usage.mjs';

const run = (home, kind, windows, session) => JSON.parse(execFileSync('python3', ['hosts/usage.py', kind, JSON.stringify(windows), ...(session ? [session] : [])], { env: { ...process.env, USAGE_HOME: home }, encoding: 'utf8' }));

test("a job's active windows are its stretches as started, not the time it sat queued or parked", () => {
  const a = { history: [{ status: 'queued', at: 'T1' }, { status: 'started', at: 'T2' }, { status: 'blocked', at: 'T3' }, { status: 'started', at: 'T4' }] };
  assert.deepEqual(activeWindows(a), [['T1', 'T2'], ['T3', 'T4']]);
});

test('Claude usage counts each assistant message once, inside the windows, split by cache TTL', () => {
  const home = mkdtempSync(`${tmpdir()}/spamton-usage-`), dir = `${home}/.claude/projects/p`;
  mkdirSync(dir, { recursive: true });
  const e = (at, id, u) => JSON.stringify({ timestamp: at, message: { id, model: 'm-a', usage: u } });
  const u = { input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, output_tokens: 5, cache_creation: { ephemeral_1h_input_tokens: 60 } };
  writeFileSync(`${dir}/s1.jsonl`, [e('2026-11-18T10:00:00Z', 'x', u), e('2026-11-18T10:00:00Z', 'x', u), e('2026-11-18T12:00:00Z', 'y', u), '{"type":"user"}'].join('\n'));
  const r = run(home, 'claude', [['2026-11-18T09:00:00Z', '2026-11-18T11:00:00Z']]);
  assert.deepEqual(r.byModel, { 'm-a': { input: 10, cacheWrite5m: 40, cacheWrite1h: 60, cacheRead: 1000, output: 5 } });
});

test('Codex usage is the growth of its running total inside the windows, cached input split out', () => {
  const home = mkdtempSync(`${tmpdir()}/spamton-usage-`), dir = `${home}/.codex/sessions/2026/11/18`;
  mkdirSync(dir, { recursive: true });
  const tc = (at, input, cached, output) => JSON.stringify({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } } });
  writeFileSync(`${dir}/rollout-a.jsonl`, [JSON.stringify({ type: 'turn_context', payload: { model: 'm-c' } }),
    tc('2026-11-18T08:00:00Z', 100, 50, 10), tc('2026-11-18T10:00:00Z', 300, 200, 30), tc('2026-11-18T10:01:00Z', 300, 200, 30), tc('2026-11-18T12:00:00Z', 900, 800, 90)].join('\n'));
  assert.deepEqual(run(home, 'codex', [['2026-11-18T09:00:00Z', '2026-11-18T11:00:00Z']]).byModel, { 'm-c': { input: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 150, output: 20 } });
});

test('cost uses the price of each model, and a model with no price leaves the cost unknown rather than zero', () => {
  const prices = { 'm-a': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 } };
  const one = { input: 1e6, cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6, output: 1e6 };
  assert.equal(costOf({ 'm-a': one }, prices), 37.2);
  assert.equal(costOf({ 'm-a': one, 'm-c': one }, prices), null);
});

test('usage is read once per finished job of a stream worker, after the date it started being recorded', () => {
  const H = (s, e) => [{ status: 'queued', at: s }, { status: 'started', at: e }];
  const state = { work: { 'W-1': { id: 'W-1', assignments: [
    { id: 'R1', kind: 'fixes', owner: 'sbx: s1', status: 'done', history: H('2026-11-18T20:00:00Z', '2026-11-18T20:30:00Z') },
    { id: 'R2', kind: 'fixes', owner: 'sbx: s1', status: 'started', history: [] },
    { id: 'R3', kind: 'review', owner: 'some reviewer', status: 'done', history: H('2026-11-18T20:00:00Z', '2026-11-18T20:30:00Z') },
    { id: 'R4', kind: 'fixes', owner: 'sbx: s1', status: 'done', history: H('2026-11-10T20:00:00Z', '2026-11-10T20:30:00Z') }] } }, manifests: {} };
  const due = usageDue(state, { workers: ['sbx: s1'], since: '2026-11-18T19:00:00Z' });
  assert.deepEqual(due.map(d => d.key), ['usage:W-1/R1']);
  assert.deepEqual(usageDue({ ...state, manifests: { 'usage:W-1/R1': {} } }, { workers: ['sbx: s1'], since: '2026-11-18T19:00:00Z' }), []);
});

test('the outcomes report adds tokens and cost per job by agent, and supervisor seats by week', async () => {
  const { outcomes, outcomesMarkdown } = await import('../core/outcomes.mjs');
  const H = (s, e) => [{ status: 'queued', at: s }, { status: 'started', at: e }];
  const work = { 'W-1': { id: 'W-1', reviews: [], findings: [], assignments: [
    { id: 'R1', kind: 'fixes', owner: 'sbx: s1', status: 'done', history: H('2026-11-18T20:00:00Z', '2026-11-18T20:30:00Z') },
    { id: 'R2', kind: 'fixes', owner: 'sbx: s1', status: 'done', history: H('2026-11-18T21:00:00Z', '2026-11-18T21:30:00Z') }] } };
  const tok = n => ({ 'm-a': { input: n, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } });
  const manifests = { 'usage:W-1/R1': { usage: tok(1000), cost: 2 }, 'usage:W-1/R2': { usage: tok(3000), cost: null } };
  const cfg = { since: '2026-11-18T00:00:00Z', until: '2026-11-19T00:00:00Z', supervisorUsage: [{ label: 'sup: s1', tokens: 5e6, cost: 12.5, sessions: 2 }] };
  const r = outcomes({ work, manifests }, cfg);
  assert.deepEqual([r.jobs[0].withUsage, r.jobs[0].meanTokens, r.jobs[0].meanCost, r.jobs[0].priced], [2, 2000, 2, 1]);
  const md = outcomesMarkdown(r, cfg);
  assert.match(md, /\| claude \| fixes \| 2 \| \d+ \| 2 \| 2,000 \| \$2\.00 \(1 of 2 priced\) \|/);
  assert.match(md, /sup: s1 \| 2 \| 5,000,000 \| \$12\.50/);
});
