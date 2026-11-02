import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWork, applyEvent } from '../core/work.mjs';
import { projectPrs, projectTasks, headCommands } from '../core/observe.mjs';

const OWNER = 'builtforteams', PR = n => `https://github.com/${OWNER}/built-rails/pull/${n}`;
// threads.sh's line shape, as V1's api/historical tests feed it.
const line = (n, head, threads = [], isDraft = true) => JSON.stringify({ repo: 'built-rails', number: n, title: 'PR', url: PR(n), baseRefName: 'main', headRefName: 'b', headRefOid: head, isDraft, threads });
const ctx = { now: '2026-10-30T16:00:00.000Z', by: 'test' };

test('every PR read gives a head; only own PRs, or PRs with threads, become items', () => {
  const { prs, heads } = projectPrs([line(1, 'aaa'), line(2, 'bbb', [{ id: 't1', bot: true }])], new Set(['built-rails:1']));
  assert.deepEqual([...prs.keys()], ['built-rails-1']);
  assert.deepEqual([...heads.keys()], ['built-rails:1', 'built-rails:2']);
  const tracked = projectPrs([line(2, 'bbb', [{ id: 't1', bot: true }]), line(3, 'ccc')]);
  assert.deepEqual([...tracked.prs.keys()], ['built-rails-2']);
  assert.deepEqual(tracked.prs.get('built-rails-2').threads, { human: 0, bot: 1 });
});

test('an epic is not work; its subtasks and undated standalone tasks are', () => {
  const t = projectTasks([{ id: 1, name: 'Epic' }, { id: 2, name: 'Sub', parentTaskId: 1, description: '<p>a&amp;b</p>' }, { id: 3, name: 'Solo' }], 'x.teamwork.com');
  assert.deepEqual([...t.keys()], ['tw-2', 'tw-3']);
  assert.equal(t.get('tw-2').description, 'a&b');
  assert.equal(t.get('tw-2').url, 'https://x.teamwork.com/app/tasks/2');
});

test('heads only produce commands when they change a record', () => {
  const w = applyEvent(createWork({ id: 'W-1', title: 'T', links: { pr: PR(1) } }, ctx), { type: 'head', sha: 'aaa1111' }, ctx).work;
  const state = { work: { 'W-1': w, 'W-2': createWork({ id: 'W-2', title: 'no PR' }, ctx) } };
  const opts = { owner: OWNER, now: ctx.now };
  const moved = headCommands(state, new Map([['built-rails:1', { sha: 'bbb2222', isDraft: true }]]), opts);
  assert.deepEqual(moved.map(c => [c.kind, c.target, c.payload.sha]), [['observe_head', 'W-1', 'bbb2222']]);
  const seen = { work: { ...state.work, 'W-1': { ...w, headVerified: { via: 'github', sha: 'aaa1111', at: 'earlier' } } } };
  assert.deepEqual(headCommands(seen, new Map([['built-rails:1', { sha: 'aaa1111', isDraft: true }]]), opts), [], 'a re-confirmed head is not news');
  assert.deepEqual(headCommands(seen, new Map(), opts).map(c => c.kind), ['unverify_head']);
});

test('health is judged only for PRs into main, and never for Mutation work', async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const rec = (id, n, branch) => ({ ...createWork({ id, title: 'x', kind: 'build', links: { pr: PR(n), branch } }, ctx), phase: 'rereview', head: 'ddddddd4' });
  const state = { work: { 'W-1': rec('W-1', 1, 'b'), 'W-2': rec('W-2', 2, 'b'), 'W-3': rec('W-3', 3, 'alex/mutation-tester') } };
  const h = base => ({ head: 'ddddddd4', base, conflict: true, failing: [] });
  const health = new Map([['built-rails:1', h('main')], ['built-rails:2', h('alex/stack-base')], ['built-rails:3', h('main')]]);
  assert.deepEqual(healthCommands(state, health, { owner: OWNER, now: ctx.now, mutationBranch: 'mutation' }).map(c => c.target), ['W-1']);
});

test('a PR carried by several records gets one health finding: its own record if in play, else the record doing the work', async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const rec = (id, phase, source) => ({ ...createWork({ id, title: 'x', kind: 'build', links: { pr: PR(9) } }, ctx), phase, head: 'eeeeeee5', ...(source ? { source: { type: 'pr', key: 'built-rails-9' } } : {}) });
  const health = new Map([['built-rails:9', { head: 'eeeeeee5', base: 'main', conflict: true, failing: [] }]]);
  const targets = work => healthCommands({ work }, health, { owner: OWNER, now: ctx.now }).map(c => c.target);
  assert.deepEqual(targets({ 'W-1': rec('W-1', 'awaiting_human_approval'), 'W-2': rec('W-2', 'awaiting_human_approval', true) }), ['W-2']);
  assert.deepEqual(targets({ 'W-1': rec('W-1', 'awaiting_human_approval'), 'W-2': rec('W-2', 'intake', true) }), ['W-1']);
});
