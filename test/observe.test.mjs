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

test("a record's project is its task's top-level parent, found from its Teamwork key or its PR branch", async () => {
  const { taskIdOf, projectCommands } = await import('../core/observe.mjs');
  const { openStore } = await import('../core/store.mjs');
  const s = openStore(), ctx = { now: '2026-11-04T12:00:00.000Z', by: 'test' };
  const task = s.append({ kind: 'create', payload: { title: 'A task', source: { type: 'teamwork', key: 'tw-41474063' } } }, ctx).id;
  const pr = s.append({ kind: 'create', payload: { title: 'A PR', links: { pr: 'https://github.com/o/r/pull/1', branch: 'alex/security/rubyzip/41474200' } } }, ctx).id;
  const loose = s.append({ kind: 'create', payload: { title: 'No task' } }, ctx).id;
  assert.deepEqual([taskIdOf(s.state.work[task]), taskIdOf(s.state.work[pr]), taskIdOf(s.state.work[loose])], ['41474063', '41474200', null]);
  const tops = new Map([['41474063', { id: '41000001', name: 'Security fixes' }], ['41474200', { id: '41000001', name: 'Security fixes' }]]);
  const cmds = projectCommands(s.state, tops);
  assert.deepEqual(cmds.map(c => [c.target, c.payload.name]), [[task, 'Security fixes'], [pr, 'Security fixes']]);
  s.appendAll(cmds, ctx);
  assert.equal(s.state.work[task].project.name, 'Security fixes');
  assert.deepEqual(projectCommands(s.state, tops), [], 'an unchanged project is not re-recorded');
});

test("the health read carries other people's change requests on the head and their unanswered threads, never Alex's own, answered or resolved ones (W-207)", async () => {
  const { readPrHealth } = await import('../sources/github.mjs');
  const node = (login, extra = {}) => ({ author: { login }, url: `https://x/${login}`, ...extra });
  const data = { p0: { pullRequest: { baseRefName: 'main', mergeable: 'MERGEABLE', headRefOid: 'aaaaaaa1', commits: { nodes: [] },
    reviews: { nodes: [{ id: 'PRR_1', ...node('sam-built'), commit: { oid: 'aaaaaaa1' } }, { id: 'PRR_2', ...node('alexbatesdev'), commit: { oid: 'aaaaaaa1' } }, { id: 'PRR_3', ...node('sam-built'), commit: { oid: 'old0000' } }] },
    reviewThreads: { nodes: [{ id: 'T1', isResolved: false, comments: { nodes: [node('sam-built')] }, last: { nodes: [node('sam-built')] } }, { id: 'T2', isResolved: true, comments: { nodes: [node('sam-built')] } },
      { id: 'T3', isResolved: false, comments: { nodes: [node('alexbatesdev')] } }, { id: 'T4', isResolved: false, comments: { nodes: [node('sam-built')] }, last: { nodes: [node('alexbatesdev')] } }] } } } };
  const run = async () => ({ stdout: JSON.stringify({ data }) });
  const h = (await readPrHealth(['built-rails:8276'], 'builtforteams', run, 'alexbatesdev')).get('built-rails:8276');
  assert.deepEqual(h.changesRequested.map(r => [r.id, r.by]), [['PRR_1', 'sam-built']]);
  assert.deepEqual(h.threads.map(t => [t.id, t.by]), [['T1', 'sam-built']]);
});

test("main counts as green only when its latest commit's checks passed (W-208)", async () => {
  const { readMainGreen } = await import('../sources/github.mjs');
  const reply = state => async () => ({ stdout: JSON.stringify({ data: { r0: { ref: { target: { oid: 'main0001', statusCheckRollup: state && { state } } } } } }) });
  assert.equal((await readMainGreen(['built-rails'], 'o', reply('SUCCESS'))).get('built-rails'), 'main0001');
  for (const s of ['FAILURE', 'PENDING', null]) assert.equal((await readMainGreen(['built-rails'], 'o', reply(s))).get('built-rails'), null, String(s));
});
