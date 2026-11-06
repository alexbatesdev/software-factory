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

test("a stacked PR's review feedback is still read; only its CI and conflicts are main's business (#8588, #8244)", async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const rec = { ...createWork({ id: 'W-1', title: 'x', kind: 'build', links: { pr: PR(1), branch: 'b' } }, ctx), phase: 'awaiting_human_approval', head: 'ddddddd4' };
  const health = new Map([['built-rails:1', { head: 'ddddddd4', base: 'alex/stack-base', conflict: true, failing: ['rspec'], changesRequested: [], threads: [{ id: 'T1', by: 'codex', url: 'u' }] }]]);
  const [c] = healthCommands({ work: { 'W-1': rec } }, health, { owner: OWNER, now: ctx.now });
  assert.equal(c.target, 'W-1');
  assert.deepEqual([c.payload.conflict, c.payload.failing, c.payload.threads.map(t => t.id)], [false, [], ['T1']]);
});

test('the health read counts conversation comments and review summaries from others after Alex last spoke, plus codex findings, never bot noise (#8577)', async () => {
  const { readPrHealth } = await import('../sources/github.mjs');
  const c = (id, login, createdAt, body = 'please fix', bot = false) => ({ id, url: `https://x/${id}`, createdAt, body, author: { login, __typename: bot ? 'Bot' : 'User' } });
  const data = { p0: { pullRequest: { baseRefName: 'main', mergeable: 'MERGEABLE', headRefOid: 'a1', commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
    comments: { nodes: [c('IC0', 'sam-built', '2026-11-06T09:00:00Z'), c('IC1', 'alexbatesdev', '2026-11-06T10:00:00Z'), c('IC2', 'chatgpt-codex-connector', '2026-11-06T11:00:00Z', '<!-- codex-pull-request-review-summary -->', true),
      c('IC3', 'chatgpt-codex-connector', '2026-11-06T11:01:00Z', '<!-- codex-code-review-finding:v1 --> P2', true), c('IC4', 'github-actions', '2026-11-06T11:02:00Z', 'audit', true), c('IC5', 'sam-built', '2026-11-06T11:03:00Z'),
      c('IC6', 'built-engineering-bot', '2026-11-06T11:03:10Z', '🤖 *Not a human. This is Hermes* <!-- hermes-verdict COMMENT (report-rows=14 found=0 proven=0) -->'), c('IC7', 'built-engineering-bot', '2026-11-06T11:03:20Z', '🤖 Hermes <!-- hermes-verdict REQUEST_CHANGES (report-rows=3 found=2 proven=1) -->')] },
    summaries: { nodes: [{ ...c('PRR_9', 'chelsieminor', null, 'one more thing'), submittedAt: '2026-11-06T11:04:00Z' }, { ...c('PRR_8', 'chelsieminor', null, ''), submittedAt: '2026-11-06T11:05:00Z' }] } } } };
  const h = (await readPrHealth(['built-rails:1'], 'o', async () => ({ stdout: JSON.stringify({ data }) }), 'alexbatesdev', '2026-11-06T00:00:00Z')).get('built-rails:1');
  assert.deepEqual(h.comments.map(t => t.id), ['IC3', 'IC5', 'IC7', 'PRR_9']); assert.deepEqual(h.threads, []);
  const old = (await readPrHealth(['built-rails:1'], 'o', async () => ({ stdout: JSON.stringify({ data }) }), 'alexbatesdev', '2026-11-06T11:03:30Z')).get('built-rails:1');
  assert.deepEqual(old.comments.map(t => t.id), ['PRR_9'], 'nothing from before the cutoff');
});

test("QA's sub-issues on an issue that references the PR count as feedback, open ones only, after the cutoff (#8244: #8580 > #8581)", async () => {
  const { readPrHealth } = await import('../sources/github.mjs');
  const iss = (id, n, createdAt, state = 'OPEN', login = 'chelsieminor', subs = []) => ({ id, number: n, url: `https://github.com/o/r/issues/${n}`, state, createdAt, author: { login }, subIssues: { nodes: subs } });
  const parent = iss('I80', 8580, '2026-11-05T23:03:00Z', 'OPEN', 'chelsieminor', [iss('I81', 8581, '2026-11-05T23:03:53Z'), iss('I82', 8582, '2026-11-05T23:04:00Z', 'CLOSED'), iss('I79', 8579, '2026-11-01T00:00:00Z')]);
  const data = { p0: { pullRequest: { baseRefName: 'main', mergeable: 'MERGEABLE', headRefOid: 'a1', commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] }, summaries: { nodes: [] },
    refs: { nodes: [{ source: parent }, { source: iss('I81', 8581, '2026-11-05T23:03:53Z') }, { source: {} }] } } } };
  const h = (await readPrHealth(['built-rails:1'], 'o', async () => ({ stdout: JSON.stringify({ data }) }), 'alexbatesdev', '2026-11-05T00:00:00Z')).get('built-rails:1');
  assert.deepEqual(h.comments.map(c => [c.id, c.by, c.url]), [['I81', 'chelsieminor', 'https://github.com/o/r/issues/8581']], 'once each; closed and pre-cutoff ones skipped');
});

test("a Teamwork task's feedback: others' comments after Alex last spoke and after the cutoff, never Teamwork Sync's PR notices", async () => {
  const { taskFeedback } = await import('../sources/teamwork.mjs');
  const c = (id, by, at, body = 'Can we also hide it here?') => ({ id, postedByUserId: by, postedDateTime: at, body });
  const got = taskFeedback('41', [c(1, 7, '2026-11-05T09:00:00Z'), c(2, 99, '2026-11-05T10:00:00Z'), c(3, 7, '2026-11-05T11:00:00Z'),
    c(4, 645330, '2026-11-05T12:00:00Z', '\n**alexbatesdev** merged a PR: **x**\n[https://github.com/o/r/pull/1](https://github.com/o/r/pull/1)\n'), c(5, 7, '2026-11-04T00:00:00Z'),
    c(6, 645330, '2026-11-05T13:00:00Z', ' **chelsieminor** submitted a review to the PR: **x** [https://github.com/o/r/pull/8265](https://github.com/o/r/pull/8265) --- '), c(7, 645330, '2026-11-05T13:01:00Z', '**chelsieminor** added label **QA In Progress** on [PR](https://github.com/o/r/pull/8244)')], { me: 99, since: '2026-11-05T00:00:00Z', site: 'acme.teamwork.com' });
  assert.deepEqual(got.map(x => [x.id, x.by]), [['tw-comment-3', 'teamwork user 7']]);
  assert.match(got[0].url, /^https:\/\/acme\.teamwork\.com\/app\/tasks\/41/);
});

test('the audit names what the GitHub read saw but no record holds: an own PR with no live record, or feedback never recorded (Mutation aside)', async () => {
  const { auditMissed } = await import('../core/observe.mjs');
  const rec = (id, n, extra = {}) => ({ ...createWork({ id, title: 'x', kind: 'build', links: { pr: PR(n), branch: 'b' } }, ctx), phase: 'awaiting_human_approval', ...extra });
  const state = { work: { 'W-1': rec('W-1', 1, { findings: [{ id: 'F1', source: { type: 'threads', ids: ['T1'] } }] }), 'W-2': rec('W-2', 2, { phase: 'done' }), 'W-3': rec('W-3', 3, { links: { pr: PR(3), branch: 'alex/mutation-tester' } }) } };
  const fb = ids => ({ changesRequested: [], threads: ids.map(id => ({ id, by: 'x', url: `u/${id}` })), comments: [] });
  const health = new Map([['built-rails:1', fb(['T1', 'T2'])], ['built-rails:2', fb([])], ['built-rails:3', fb(['T9'])]]);
  const missed = auditMissed(state, new Set(['built-rails:1', 'built-rails:2', 'built-rails:3', 'built-rails:4']), health, { owner: OWNER, mutationBranch: 'mutation', prs: new Map([['built-rails-4', { branch: 'alex/mutation-round-5' }]]) });
  assert.deepEqual(missed.map(m => [m.key, m.id]), [['built-rails:1', 'T2'], ['built-rails:2', 'pr']]);
});
