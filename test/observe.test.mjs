import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWork, applyEvent } from '../core/work.mjs';
import { projectPrs, projectTasks, headCommands } from '../core/observe.mjs';

const OWNER = 'acme-org', PR = n => `https://github.com/${OWNER}/app/pull/${n}`;
// threads.sh's line shape, as V1's api/historical tests feed it.
const line = (n, head, threads = [], isDraft = true) => JSON.stringify({ repo: 'app', number: n, title: 'PR', url: PR(n), baseRefName: 'main', headRefName: 'b', headRefOid: head, isDraft, threads });
const ctx = { now: '2026-10-30T16:00:00.000Z', by: 'test' };

test('every PR read gives a head; only own PRs, or PRs with threads, become items', () => {
  const { prs, heads } = projectPrs([line(1, 'aaa'), line(2, 'bbb', [{ id: 't1', bot: true }])], new Set(['app:1']));
  assert.deepEqual([...prs.keys()], ['app-1']);
  assert.deepEqual([...heads.keys()], ['app:1', 'app:2']);
  const tracked = projectPrs([line(2, 'bbb', [{ id: 't1', bot: true }]), line(3, 'ccc')]);
  assert.deepEqual([...tracked.prs.keys()], ['app-2']);
  assert.deepEqual(tracked.prs.get('app-2').threads, { human: 0, bot: 1 });
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
  const moved = headCommands(state, new Map([['app:1', { sha: 'bbb2222', isDraft: true }]]), opts);
  assert.deepEqual(moved.map(c => [c.kind, c.target, c.payload.sha]), [['observe_head', 'W-1', 'bbb2222']]);
  const seen = { work: { ...state.work, 'W-1': { ...w, headVerified: { via: 'github', sha: 'aaa1111', at: 'earlier' } } } };
  assert.deepEqual(headCommands(seen, new Map([['app:1', { sha: 'aaa1111', isDraft: true }]]), opts), [], 'a re-confirmed head is not news');
  assert.deepEqual(headCommands(seen, new Map(), opts).map(c => c.kind), ['unverify_head']);
});

test('a conflict is judged for PRs into main and stacked PRs alike (W-459), never for an excluded record', async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const rec = (id, n, branch) => ({ ...createWork({ id, title: 'x', kind: 'build', links: { pr: PR(n), branch } }, ctx), phase: 'rereview', head: 'ddddddd4' });
  const state = { work: { 'W-1': rec('W-1', 1, 'b'), 'W-2': rec('W-2', 2, 'b'), 'W-3': rec('W-3', 3, 'alex/mutation-tester') } };
  const h = base => ({ head: 'ddddddd4', base, conflict: true, failing: [] });
  const health = new Map([['app:1', h('main')], ['app:2', h('alex/stack-base')], ['app:3', h('main')]]);
  assert.deepEqual(healthCommands(state, health, { owner: OWNER, now: ctx.now, exclude: ['W-3'] }).map(c => c.target), ['W-1', 'W-2']);
});

test('a PR carried by several records gets one health finding: its own record if in play, else the record doing the work', async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const rec = (id, phase, source) => ({ ...createWork({ id, title: 'x', kind: 'build', links: { pr: PR(9) } }, ctx), phase, head: 'eeeeeee5', ...(source ? { source: { type: 'pr', key: 'app-9' } } : {}) });
  const health = new Map([['app:9', { head: 'eeeeeee5', base: 'main', conflict: true, failing: [] }]]);
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
    reviews: { nodes: [{ id: 'PRR_1', ...node('reviewer-sam'), commit: { oid: 'aaaaaaa1' } }, { id: 'PRR_2', ...node('alexbatesdev'), commit: { oid: 'aaaaaaa1' } }, { id: 'PRR_3', ...node('reviewer-sam'), commit: { oid: 'old0000' } }] },
    reviewThreads: { nodes: [{ id: 'T1', isResolved: false, comments: { nodes: [node('reviewer-sam')] }, last: { nodes: [node('reviewer-sam')] } }, { id: 'T2', isResolved: true, comments: { nodes: [node('reviewer-sam')] } },
      { id: 'T3', isResolved: false, comments: { nodes: [node('alexbatesdev')] } }, { id: 'T4', isResolved: false, comments: { nodes: [node('reviewer-sam')] }, last: { nodes: [node('alexbatesdev')] } }] } } } };
  const run = async () => ({ stdout: JSON.stringify({ data }) });
  const h = (await readPrHealth(['app:8276'], 'acme-org', run, 'alexbatesdev')).get('app:8276');
  assert.deepEqual(h.changesRequested.map(r => [r.id, r.by]), [['PRR_1', 'reviewer-sam']]);
  assert.deepEqual(h.threads.map(t => [t.id, t.by]), [['T1', 'reviewer-sam']]);
});

test("main counts as green only when its latest commit's checks passed (W-208)", async () => {
  const { readMain } = await import('../sources/github.mjs');
  const reply = state => async () => ({ stdout: JSON.stringify({ data: { r0: { ref: { target: { oid: 'main0001', statusCheckRollup: state && { state } } } } } }) });
  assert.equal((await readMain(['app'], 'o', reply('SUCCESS'))).get('app').green, 'main0001');
  for (const s of ['FAILURE', 'PENDING', null]) assert.equal((await readMain(['app'], 'o', reply(s))).get('app').green, null, String(s));
});

test("a stacked PR's review feedback is read, and and its conflict and red CI are handled like a PR into main's; a base with no tracked PR inherits nothing (#8588, #8244, W-459: #8591)", async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const rec = { ...createWork({ id: 'W-1', title: 'x', kind: 'build', links: { pr: PR(1), branch: 'b' } }, ctx), phase: 'awaiting_human_approval', head: 'ddddddd4' };
  const health = new Map([['app:1', { head: 'ddddddd4', base: 'alex/stack-base', conflict: true, failing: ['rspec'], changesRequested: [], threads: [{ id: 'T1', by: 'codex', url: 'u' }] }]]);
  const [c] = healthCommands({ work: { 'W-1': rec } }, health, { owner: OWNER, now: ctx.now });
  assert.equal(c.target, 'W-1');
  assert.deepEqual([c.payload.conflict, c.payload.base, c.payload.failing, c.payload.threads.map(t => t.id)], [true, 'alex/stack-base', ['rspec'], ['T1']]);
  const { observeHealth } = await import('../core/work.mjs');
  const f = observeHealth(rec, c.payload, ctx).findings.find(x => x.source.type === 'conflict');
  assert.match(f.text, /Conflicts with alex\/stack-base .*Merge origin\/alex\/stack-base into the branch/);
});

test('the health read counts conversation comments and review summaries from others after Alex last spoke, plus codex findings, never bot noise (#8577)', async () => {
  const { readPrHealth } = await import('../sources/github.mjs');
  const c = (id, login, createdAt, body = 'please fix', bot = false) => ({ id, url: `https://x/${id}`, createdAt, body, author: { login, __typename: bot ? 'Bot' : 'User' } });
  const data = { p0: { pullRequest: { baseRefName: 'main', mergeable: 'MERGEABLE', headRefOid: 'a1', commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] },
    comments: { nodes: [c('IC0', 'reviewer-sam', '2026-11-06T09:00:00Z'), c('IC1', 'alexbatesdev', '2026-11-06T10:00:00Z'), c('IC2', 'chatgpt-codex-connector', '2026-11-06T11:00:00Z', '<!-- codex-pull-request-review-summary -->', true),
      c('IC3', 'chatgpt-codex-connector', '2026-11-06T11:01:00Z', '<!-- codex-code-review-finding:v1 --> P2', true), c('IC4', 'github-actions', '2026-11-06T11:02:00Z', 'audit', true), c('IC5', 'reviewer-sam', '2026-11-06T11:03:00Z'),
      c('IC6', 'built-engineering-bot', '2026-11-06T11:03:10Z', '🤖 *Not a human. This is Hermes* <!-- hermes-verdict COMMENT (report-rows=14 found=0 proven=0) -->'), c('IC7', 'built-engineering-bot', '2026-11-06T11:03:20Z', '🤖 Hermes <!-- hermes-verdict REQUEST_CHANGES (report-rows=3 found=2 proven=1) -->')] },
    summaries: { nodes: [{ ...c('PRR_9', 'chelsieminor', null, 'one more thing'), submittedAt: '2026-11-06T11:04:00Z' }, { ...c('PRR_8', 'chelsieminor', null, ''), submittedAt: '2026-11-06T11:05:00Z' }] } } } };
  const h = (await readPrHealth(['app:1'], 'o', async () => ({ stdout: JSON.stringify({ data }) }), 'alexbatesdev', '2026-11-06T00:00:00Z')).get('app:1');
  assert.deepEqual(h.comments.map(t => t.id), ['IC3', 'IC5', 'IC7', 'PRR_9']); assert.deepEqual(h.threads, []);
  const old = (await readPrHealth(['app:1'], 'o', async () => ({ stdout: JSON.stringify({ data }) }), 'alexbatesdev', '2026-11-06T11:03:30Z')).get('app:1');
  assert.deepEqual(old.comments.map(t => t.id), ['PRR_9'], 'nothing from before the cutoff');
});

test("QA's sub-issues on an issue that references the PR count as feedback, open ones only, after the cutoff (#8244: #8580 > #8581)", async () => {
  const { readPrHealth } = await import('../sources/github.mjs');
  const iss = (id, n, createdAt, state = 'OPEN', login = 'chelsieminor', subs = []) => ({ id, number: n, url: `https://github.com/o/r/issues/${n}`, state, createdAt, author: { login }, subIssues: { nodes: subs } });
  const parent = iss('I80', 8580, '2026-11-05T23:03:00Z', 'OPEN', 'chelsieminor', [iss('I81', 8581, '2026-11-05T23:03:53Z'), iss('I82', 8582, '2026-11-05T23:04:00Z', 'CLOSED'), iss('I79', 8579, '2026-11-01T00:00:00Z')]);
  const data = { p0: { pullRequest: { baseRefName: 'main', mergeable: 'MERGEABLE', headRefOid: 'a1', commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] }, summaries: { nodes: [] },
    refs: { nodes: [{ source: parent }, { source: iss('I81', 8581, '2026-11-05T23:03:53Z') }, { source: {} }] } } } };
  const h = (await readPrHealth(['app:1'], 'o', async () => ({ stdout: JSON.stringify({ data }) }), 'alexbatesdev', '2026-11-05T00:00:00Z')).get('app:1');
  assert.deepEqual(h.comments.map(c => [c.id, c.by, c.url]), [['I81', 'chelsieminor', 'https://github.com/o/r/issues/8581']], 'once each; closed and pre-cutoff ones skipped');
});

test("an issue whose last word is Alex's, or one a bot opened with nothing under it, isn't feedback (W-86 R3 #8581, W-192 R6 #8584)", async () => {
  const { readPrHealth } = await import('../sources/github.mjs');
  const iss = (id, n, extra = {}) => ({ id, number: n, url: `u/${n}`, state: 'OPEN', createdAt: '2026-11-06T00:00:00Z', author: { login: 'chelsieminor', __typename: 'User' }, subIssues: { nodes: [] }, comments: { nodes: [] }, ...extra });
  const answered = iss('I81', 8581, { comments: { nodes: [{ author: { login: 'alexbatesdev' } }] } });
  const auto = iss('I84', 8584, { author: { login: 'github-actions', __typename: 'Bot' } });
  const fresh = iss('I85', 8585, { comments: { nodes: [{ author: { login: 'chelsieminor' } }] } });
  const data = { p0: { pullRequest: { baseRefName: 'main', mergeable: 'MERGEABLE', headRefOid: 'a1', commits: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, comments: { nodes: [] }, summaries: { nodes: [] },
    refs: { nodes: [{ source: iss('I80', 8580, { subIssues: { nodes: [answered, fresh] } }) }, { source: auto }] } } } };
  const h = (await readPrHealth(['app:1'], 'o', async () => ({ stdout: JSON.stringify({ data }) }), 'alexbatesdev', '2026-11-05T00:00:00Z')).get('app:1');
  assert.deepEqual(h.comments.map(c => c.id), ['I85']);
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

test("a Teamwork comment's feedback carries its text as plain words, so a fixes round needs no Teamwork read (W-445)", async () => {
  const { taskFeedback } = await import('../sources/teamwork.mjs');
  const [c] = taskFeedback('41', [{ id: 9, postedByUserId: 7, postedDateTime: '2026-11-12T04:00:00Z', body: '<p>Terminated today still shows&nbsp;<b>active</b></p>' }], { me: 99, site: 'acme.teamwork.com' });
  assert.equal(c.text, 'Terminated today still shows active');
});

test('the audit names what the GitHub read saw but no record holds: an own PR with no live record, or feedback never recorded (excluded records aside)', async () => {
  const { auditMissed } = await import('../core/observe.mjs');
  const rec = (id, n, extra = {}) => ({ ...createWork({ id, title: 'x', kind: 'build', links: { pr: PR(n), branch: 'b' } }, ctx), phase: 'awaiting_human_approval', ...extra });
  const state = { work: { 'W-1': rec('W-1', 1, { findings: [{ id: 'F1', source: { type: 'threads', ids: ['T1'] } }] }), 'W-2': rec('W-2', 2, { phase: 'done' }), 'W-3': rec('W-3', 3, { links: { pr: PR(3), branch: 'alex/mutation-tester' } }) } };
  const fb = ids => ({ changesRequested: [], threads: ids.map(id => ({ id, by: 'x', url: `u/${id}` })), comments: [] });
  const health = new Map([['app:1', fb(['T1', 'T2'])], ['app:2', fb([])], ['app:3', fb(['T9'])]]);
  const missed = auditMissed(state, new Set(['app:1', 'app:2', 'app:3', 'app:4']), health, { owner: OWNER, exclude: ['W-3'], prs: new Map([['app-4', { branch: 'alex/mutation-round-5' }]]) });
  assert.deepEqual(missed.map(m => [m.key, m.id]), [['app:1', 'T2'], ['app:2', 'pr'], ['app:4', 'pr']]);
});

test('a new head on a reviewed PR carries GitHub ancestry from the reviewed head, read only where lineage is unknown', async () => {
  const { ancestryWanted } = await import('../core/observe.mjs');
  const now = '2026-11-10T09:00:00.000Z', c = { now, by: 'test' };
  let w = createWork({ id: 'W-1', title: 'T', kind: 'build', links: { pr: PR(1) } }, c);
  w = { ...w, phase: 'ready_for_human', head: 'aaa1111', headVerified: { via: 'github', sha: 'aaa1111' }, reviews: [{ head: 'aaa1111', by: 'r', result: 'clean' }] };
  const state = { work: { 'W-1': w } }, heads = new Map([['app:1', { sha: 'bbb2222', isDraft: true }]]);
  assert.deepEqual(ancestryWanted(state, heads, OWNER), [{ id: 'W-1', repo: 'app', base: 'aaa1111', head: 'bbb2222' }]);
  const [cmd] = headCommands(state, heads, { owner: OWNER, now, ancestry: new Map([['W-1', { base: 'aaa1111', status: 'diverged' }]]) });
  assert.deepEqual(cmd.payload.ancestry, { base: 'aaa1111', status: 'diverged' });
  const after = applyEvent(w, { type: 'head', sha: 'aaa1111' }, c).work;
  assert.deepEqual(ancestryWanted({ work: { 'W-1': after } }, new Map([['app:1', { sha: 'aaa1111' }]]), OWNER), [], 'the reviewed head itself needs no read');
});

test("a task from a support project is support work; others carry no flag (Alex's support week, 11-09)", () => {
  const t = projectTasks([{ id: 5, name: 'Carrix | INVESTIGATE', projectId: 1010115 }, { id: 6, name: 'Sprint task', projectId: 555099 }], 'x.teamwork.com', [1010115]);
  assert.equal(t.get('tw-5').support, true);
  assert.equal('support' in t.get('tw-6'), false, 'no flag, so records outside support never change');
});

test("a live record that holds an own PR's key as an alias is that PR's record for the audit (W-365: #8699 on W-359)", async () => {
  const { auditMissed } = await import('../core/observe.mjs');
  const w = { ...createWork({ id: 'W-359', title: 'PortNOLA', kind: 'build', source: { type: 'teamwork', key: 'tw-1' } }, ctx), phase: 'ready_for_human', aliases: ['app-8699'] };
  assert.deepEqual(auditMissed({ work: { 'W-359': w } }, new Set(['app:8699']), new Map(), { owner: OWNER }), []);
});

test("the open-PR search asks for every PR, not gh's default 30 (W-372: 46 open, so #8363's conflict was never read)", async () => {
  const { readPrLines } = await import('../sources/github.mjs');
  let args = null;
  await readPrLines({ owner: 'o' }, async (cmd, a) => { if (cmd === 'gh') args = a; return { stdout: '' }; });
  const i = args.indexOf('--limit');
  assert.ok(i > 0 && Number(args[i + 1]) >= 1000, `gh search needs --limit; got ${args.join(' ')}`);
});

test("a stacked PR's failing check is ours when its base PR doesn't fail it; unread base, or the same failure on the base, stays the base's (W-375: #8244, #8629)", async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const rec = { ...createWork({ id: 'W-85', title: 'x', kind: 'build', links: { pr: PR(8244), branch: 'alex/ped/3' } }, ctx), phase: 'awaiting_human_approval', head: 'aaaaaaa1' };
  const stacked = { head: 'aaaaaaa1', base: 'alex/ped/2', conflict: false, failing: ['ci/circleci: test', 'Audit Ruby'], changesRequested: [], threads: [], comments: [] };
  const run = (baseFailing, branches) => healthCommands({ work: { 'W-85': rec } }, new Map([['app:8244', stacked], ...(baseFailing ? [['app:8242', { head: 'b1', base: 'main', conflict: false, failing: baseFailing }]] : [])]), { owner: OWNER, now: ctx.now, branches })[0]?.payload.failing;
  const br = new Map([['app-8242', 'alex/ped/2'], ['app-8244', 'alex/ped/3']]);
  assert.deepEqual(run(['Audit Ruby'], br), ['ci/circleci: test'], 'only what the base passes');
  assert.equal(run(null, br), undefined, 'base not read: nothing claimed');
  assert.deepEqual(run(['ci/circleci: test', 'Audit Ruby'], br), [], 'every failure is the base\'s too: noted on the record, nothing claimed');
});

test("a PR's new health finding lands on the record already fixing it, not a second record (W-377)", async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const mk = (id, extra) => ({ ...createWork({ id, title: 'x', kind: 'build', links: { pr: PR(8363) } }, ctx), head: 'bbbbbbb2', ...extra });
  const work = { 'W-76': mk('W-76', { phase: 'awaiting_human_approval' }), 'W-152': mk('W-152', { phase: 'fixes', assignments: [{ id: 'R2', kind: 'fixes', status: 'started', owner: 'sup: s' }] }) };
  const health = new Map([['app:8363', { head: 'bbbbbbb2', base: 'main', conflict: true, failing: [], changesRequested: [], threads: [], comments: [] }]]);
  assert.deepEqual(healthCommands({ work }, health, { owner: OWNER, now: ctx.now }).map(c => c.target), ['W-152']);
});

test("a PR its record replaced (done replacesPr) is accounted for after that record closes, so the audit stays quiet (W-354: #8694 replaced by merged #8707)", async () => {
  const { auditMissed } = await import('../core/observe.mjs');
  const w = { ...createWork({ id: 'W-354', title: 'ACME', kind: 'build', links: { pr: PR(8707) } }, ctx), phase: 'done', aliases: ['app-8694', 'app-8707'] };
  assert.deepEqual(auditMissed({ work: { 'W-354': w } }, new Set(['app:8694']), new Map(), { owner: OWNER }), []);
  assert.deepEqual(auditMissed({ work: { 'W-354': { ...w, links: { pr: PR(8694) } } } }, new Set(['app:8694']), new Map(), { owner: OWNER }).map(m => m.id), ['pr'], 'its own PR still open after close is a gap');
});

test("red CI on any PR: what also fails on its base is proposed once as separate work for Alex, what the PR causes gets a fixes round (W-459: #8593-#8628 Audit Ruby)", async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const { observeHealth } = await import('../core/work.mjs');
  const rec = (id, n, branch) => ({ ...createWork({ id, title: 'x', kind: 'build', links: { pr: PR(n), branch } }, ctx), phase: 'awaiting_human_approval', head: 'aaaaaaa1' });
  const h = (base, failing) => ({ head: 'aaaaaaa1', base, conflict: false, failing, changesRequested: [], threads: [], comments: [] });
  const work = { 'W-1': rec('W-1', 1, 'a/1'), 'W-2': rec('W-2', 2, 'a/2'), 'W-3': rec('W-3', 3, 'a/3') };
  const health = new Map([['app:1', h('main', ['Audit Ruby', 'rspec'])], ['app:2', h('main', ['Audit Ruby'])], ['app:3', h('someone/untracked', ['Audit Ruby'])]]);
  const cmds = healthCommands({ work }, health, { owner: OWNER, now: ctx.now, mainFailing: new Map([['app', ['Audit Ruby']]]) });
  const of = id => cmds.find(c => c.target === id)?.payload;
  assert.deepEqual([of('W-1').failing, of('W-1').inherited], [['rspec'], ['Audit Ruby']]);
  assert.deepEqual([of('W-2').failing, of('W-2').inherited], [[], ['Audit Ruby']]);
  assert.deepEqual(of('W-3').failing, ['Audit Ruby'], 'a base with no tracked PR: handled like main, the PR\'s own');
  const creates = cmds.filter(c => c.kind === 'create');
  assert.deepEqual(creates.map(c => [c.payload.source.key, c.payload.source.by, c.payload.kind]), [['ci:app:Audit Ruby', 'board (ci)', 'build']], 'one proposal per check, not per PR');
  const held = { ...work, 'W-9': { ...createWork({ id: 'W-9', title: 'Audit', kind: 'build', source: { type: 'manual', key: 'ci:app:Audit Ruby' } }, ctx) } };
  const aliased = { ...work, 'W-379': { ...createWork({ id: 'W-379', title: 'Bundler Audit', kind: 'build', aliases: ['ci:app:Audit Ruby'] }, ctx) } };
  assert.equal(healthCommands({ work: aliased }, health, { owner: OWNER, now: ctx.now, mainFailing: new Map([['app', ['Audit Ruby']]]) }).filter(c => c.kind === 'create').length, 0, 'a record that took the check as an alias holds it too');
  assert.equal(healthCommands({ work: held }, health, { owner: OWNER, now: ctx.now, mainFailing: new Map([['app', ['Audit Ruby']]]) }).filter(c => c.kind === 'create').length, 0, 'an open record for the check already holds it');
  const w2 = observeHealth(work['W-2'], of('W-2'), ctx);
  assert.equal(w2.phase, 'awaiting_human_approval', 'no fixes round for an inherited failure');
  assert.match(w2.updates.at(-1).text, /Audit Ruby also fails on main/);
  assert.equal(observeHealth(w2, of('W-2'), ctx), w2, 'said once per head');
  assert.equal(observeHealth(work['W-1'], of('W-1'), ctx).phase, 'fixes', 'its own failure still gets a fixes round');
});

test('a CI proposal waits in New PRs for Alex, like any new PR nobody asked for (W-459)', async () => {
  const { needsPrApproval, DEFAULT_REPO } = await import('../core/work.mjs');
  const w = createWork({ id: 'W-9', title: 'Audit Ruby fails on main', kind: 'build', source: { type: 'agent', by: 'board (ci)', key: 'ci:app:Audit Ruby' } }, ctx);
  assert.equal(needsPrApproval(w, { trusted: ['teamwork', 'agent:local-head'], repos: [DEFAULT_REPO] }), true);
});

test('the main read returns the green head and the names of the checks failing on main (W-459)', async () => {
  const { readMain } = await import('../sources/github.mjs');
  const reply = (state, nodes) => async () => ({ stdout: JSON.stringify({ data: { r0: { ref: { target: { oid: 'main0001', statusCheckRollup: { state, contexts: { nodes } } } } } } }) });
  assert.deepEqual((await readMain(['app'], 'o', reply('SUCCESS', [{ name: 'rspec', conclusion: 'SUCCESS' }]))).get('app'), { green: 'main0001', failing: [] });
  assert.deepEqual((await readMain(['app'], 'o', reply('FAILURE', [{ name: 'Audit Ruby', conclusion: 'FAILURE' }, { name: 'rspec', conclusion: null, status: 'IN_PROGRESS' }]))).get('app'), { green: null, failing: ['Audit Ruby'] });
});

test("a PR's note on a check red on main names the open record already tracking it, rather than promising a new proposal (W-470: W-221, W-463)", async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const { observeHealth } = await import('../core/work.mjs');
  const pr = { ...createWork({ id: 'W-221', title: 'x', kind: 'build', links: { pr: PR(1), branch: 'a/1' } }, ctx), phase: 'awaiting_human_approval', head: 'aaaaaaa1' };
  const holder = { ...createWork({ id: 'W-463', title: 'Brakeman warning', kind: 'build', aliases: ['ci:app:Audit Ruby'] }, ctx), phase: 'ready' };
  const health = new Map([['app:1', { head: 'aaaaaaa1', base: 'main', conflict: false, failing: ['Audit Ruby'], changesRequested: [], threads: [], comments: [] }]]);
  const cmds = healthCommands({ work: { 'W-221': pr, 'W-463': holder } }, health, { owner: OWNER, now: ctx.now, mainFailing: new Map([['app', ['Audit Ruby']]]) });
  assert.equal(cmds.filter(c => c.kind === 'create').length, 0);
  const note = observeHealth(pr, cmds[0].payload, ctx).updates.at(-1).text;
  assert.match(note, /Tracked on W-463/);
  assert.doesNotMatch(note, /proposes it/);
});

test('declining a watcher record that names the record covering it moves every ci key there, so the watcher does not refile (W-474: W-467 → W-463)', async () => {
  const { openStore } = await import('../core/store.mjs');
  const { healthCommands } = await import('../core/observe.mjs');
  const store = openStore(':memory:'), c = { now: '2026-11-13T17:20:00.000Z', by: 'local-head' };
  store.append({ kind: 'create', payload: { title: 'Brakeman', kind: 'build' } }, c);
  store.append({ kind: 'create', payload: { title: 'unit-tests red on main', kind: 'build', source: { type: 'agent', by: 'board (ci)', key: 'ci:app:ci/circleci: unit-tests' } } }, c);
  store.state.work['W-2'].aliases = ['ci:app:ci/circleci: test'];
  store.append({ kind: 'event', target: 'W-2', payload: { type: 'withdraw', note: 'Alex declined (via local-head): "decline W-2 and approve the others". Note: Covered by W-1 R4, which ports the fix.' } }, c);
  assert.deepEqual(store.state.work['W-1'].aliases.sort(), ['ci:app:ci/circleci: test', 'ci:app:ci/circleci: unit-tests']);
  const health = new Map([['app:1', { head: 'aaaaaaa1', base: 'main', conflict: false, failing: ['ci/circleci: unit-tests', 'ci/circleci: test'], changesRequested: [], threads: [], comments: [] }]]);
  const pr = { ...createWork({ id: 'W-9', title: 'x', kind: 'build', links: { pr: PR(1), branch: 'a/1' } }, ctx), phase: 'awaiting_human_approval', head: 'aaaaaaa1' };
  const cmds = healthCommands({ work: { ...store.state.work, 'W-9': pr } }, health, { owner: OWNER, now: '2026-11-13T17:06:00.000Z', mainFailing: new Map([['app', ['ci/circleci: unit-tests', 'ci/circleci: test']]]) });
  assert.equal(cmds.filter(x => x.kind === 'create').length, 0);
});

test('a watcher record declined without naming a covering record still holds its check for a week', async () => {
  const { healthCommands } = await import('../core/observe.mjs');
  const declined = { ...createWork({ id: 'W-5', title: 'red', kind: 'build', source: { type: 'agent', by: 'board (ci)', key: 'ci:app:Audit Ruby' } }, ctx), phase: 'cancelled', completion: { withdrawn: 'Alex declined: not now', at: '2026-11-13T17:00:00.000Z' } };
  const pr = { ...createWork({ id: 'W-9', title: 'x', kind: 'build', links: { pr: PR(1), branch: 'a/1' } }, ctx), phase: 'awaiting_human_approval', head: 'aaaaaaa1' };
  const health = new Map([['app:1', { head: 'aaaaaaa1', base: 'main', conflict: false, failing: ['Audit Ruby'], changesRequested: [], threads: [], comments: [] }]]);
  const run = now => healthCommands({ work: { 'W-5': declined, 'W-9': pr } }, health, { owner: OWNER, now, mainFailing: new Map([['app', ['Audit Ruby']]]) }).filter(x => x.kind === 'create').length;
  assert.equal(run('2026-11-14T17:00:00.000Z'), 0);
  assert.equal(run('2026-11-21T17:00:01.000Z'), 1, 'a week on, still red: proposed again');
});
