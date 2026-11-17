import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReadme } from '../core/spec.mjs';
import { buildProjects } from '../core/projects.mjs';

const README = `# Position End Date

Positions get an end date.

| | |
| --- | --- |
| Stage | Development |
| Status | In progress |
| Teamwork | https://acme.teamwork.com/app/tasks/100 |
| Owner | Casey Example |
`;

test("a planning README gives the project's title, Stage, Status, Teamwork root and Owner", () => {
  assert.deepEqual(parseReadme(README), { title: 'Position End Date', stage: 'Development', status: 'In progress', teamworkTask: '100', owner: 'Casey Example' });
  assert.deepEqual(parseReadme('# Draft idea\n\n| | |\n| --- | --- |\n| Stage | |\n| Teamwork | |\n'), { title: 'Draft idea', stage: null, status: null, teamworkTask: null, owner: null });
});

// Teamwork tree: 100 > (101 Editing > 111, 112), 102. Leaves are 111, 112 and 102 (D-013: a leaf is one PR).
const TREE = [
  { id: '101', name: 'Editing', parent: '100', status: 'new' },
  { id: '111', name: 'Edit modal', parent: '101', status: 'completed' },
  { id: '112', name: 'Bulk edit', parent: '101', status: 'new' },
  { id: '102', name: 'Import column', parent: '100', status: 'new' },
];
const PR = n => `https://github.com/acme-org/app/pull/${n}`;
const works = {
  'W-1': { id: 'W-1', phase: 'awaiting_human_approval', source: { type: 'teamwork', key: 'tw-112' }, links: { pr: PR(8) } },
  'W-2': { id: 'W-2', phase: 'implementation', source: { type: 'pr', key: 'app-9' }, links: { pr: PR(9) } },
};
const prs = new Map([
  ['app-7', { url: PR(7), number: 7, title: 'Unrelated fix', branch: 'alex/tw-1021-other', base: 'main', isDraft: false }],
  ['app-8', { url: PR(8), number: 8, title: 'Bulk edit', branch: 'alex/tw-112-bulk-edit', base: 'main', isDraft: false }],
  ['app-9', { url: PR(9), number: 9, title: 'Import column', branch: 'alex/tw-102-import', base: 'alex/tw-112-bulk-edit', isDraft: true }],
]);
const planning = [{ slug: '2026-10-position-end-date', readme: parseReadme(README), reqs: 12, openDecisions: 1, testPlans: ['111', '112'] }];

test('a project is its planning folder joined to its Teamwork tree; its leaves carry their record and PR, and progress counts finished leaves', () => {
  const [p] = buildProjects({ planning, trees: { 100: TREE }, works, prs }).projects;
  assert.equal(p.slug, '2026-10-position-end-date');
  assert.deepEqual([p.stage, p.status, p.owner, p.reqs, p.openDecisions], ['Development', 'In progress', 'Casey Example', 12, 1]);
  assert.deepEqual(p.leaves.map(l => [l.task, l.path, l.state, l.work, l.pr?.number ?? null, l.testPlan]), [
    ['111', 'Editing / Edit modal', 'done', null, null, true],
    ['112', 'Editing / Bulk edit', 'awaiting approval', 'W-1', 8, true],
    ['102', 'Import column', 'building', 'W-2', 9, false],
  ]);
  assert.deepEqual(p.progress, { done: 1, total: 3 });
});

test("a PR stacked on another PR's branch names it, and Alex's PRs outside every project are listed apart", () => {
  const { projects, loose } = buildProjects({ planning, trees: { 100: TREE }, works, prs });
  assert.equal(projects[0].leaves.find(l => l.task === '102').pr.stackedOn, 8);
  assert.deepEqual(loose.map(p => p.number), [7], 'tw-1021 is not task 102');
});

test('a project whose Teamwork tree is not read yet still shows, with no leaves', () => {
  const [p] = buildProjects({ planning, trees: {}, works, prs }).projects;
  assert.deepEqual([p.leaves.length, p.progress.total, p.treeRead], [0, 0, false]);
});

// Phase B (Alex 11-16, decision 5): no leaf of a project starts until the project has a spec with REQ IDs, the leaf a test
// plan, and no open decision touches it (mentions its task or a REQ its plan covers).
const gated = (over = {}) => buildProjects({ planning: [{ ...planning[0], reqs: 12, testPlanReqs: { 111: ['REQ-001'], 112: ['REQ-019'] }, decisions: [], factoryPlan: true, ...over }], trees: { 100: TREE }, works, prs }).projects[0];
const leaf = (p, t) => p.leaves.find(l => l.task === t);

test('a project leaf is ready to start once the spec has REQs, it has a test plan and no open decision touches it', () => {
  assert.deepEqual(leaf(gated(), '112').gate, { ready: true, reasons: [] });
});

test("a leaf waits for the project's spec, its own test plan, and any open decision that names its task or a REQ its plan covers", () => {
  assert.match(leaf(gated({ reqs: 0 }), '112').gate.reasons.join(), /spec\.md has no requirements \(REQ IDs\)/);
  assert.match(leaf(gated(), '102').gate.reasons.join(), /no test plan for task 102/);
  const d = (id, text) => ({ id, title: `t ${id}`, text });
  const p = gated({ decisions: [d('D-033', 'question: ... configured only for one customer (REQ-019).'), d('D-032', 'question: Is it in the public API?'), d('D-040', 'refs: tasks/111')] });
  assert.deepEqual(leaf(p, '112').gate, { ready: false, reasons: ['open decision D-033 (t D-033) covers REQ-019'] });
  assert.match(leaf(p, '111').gate.reasons.join(), /D-040 .* names task 111/);
  assert.ok(!leaf(p, '112').gate.reasons.some(r => r.includes('D-032')), 'a question tied to no task or REQ shows on the project but holds no task');
  assert.deepEqual(p.decisions.map(x => x.id), ['D-033', 'D-032', 'D-040']);
});

test("a decision keeps its full text, so a gate can see which REQ or task it mentions", async () => {
  const { parseDecisions } = await import('../core/spec.mjs');
  const [d] = parseDecisions('### D-033 — Two more customers\n- status: open\n- rationale: only one customer for now (REQ-019).\n');
  assert.match(d.text, /REQ-019/);
});

// Phase C (Alex 11-16): one planning job per project the factory is about to work, on the host stream, through a PR Alex merges.
const C = (over = {}, worksOver = works) => buildProjects({ planning: [{ ...planning[0], reqs: 12, testPlanReqs: { 111: [], 112: [] }, decisions: [], factoryPlan: false, factoryDecisions: [], ...over }], trees: { 100: TREE.map(n => ({ ...n, assignees: n.id === '112' ? ['Alex Bates'] : ['Casey Example'] })) }, works: worksOver, prs }).projects[0];

test('a leaf also waits for the project\'s factory plan on main, and open factory decisions hold it like the team\'s', () => {
  assert.match(leaf(C(), '112').gate.reasons.join(), /no factory implementation plan on project-planning main \(projects\/2026-10-position-end-date\/factory\/implementation-plan\.md\)/);
  assert.deepEqual(leaf(C({ factoryPlan: true }), '112').gate, { ready: true, reasons: [] });
  const held = leaf(C({ factoryPlan: true, factoryDecisions: [{ id: 'FD-002', title: 'Bulk edit limit', text: 'needs: Casey\nrefs: 112' }] }), '112');
  assert.deepEqual(held.gate.reasons, ['open decision FD-002 (Bulk edit limit) names task 112']);
});

test('a project gets one planning job when the factory has a record on one of its tasks not built yet and no plan is on main', async () => {
  const { triageCreates } = await import('../core/projects.mjs');
  const queued = { ...works, 'W-3': { id: 'W-3', phase: 'ready', source: { type: 'teamwork', key: 'tw-102' }, links: {} } };
  const [c] = triageCreates([C({}, queued)], queued, { questionsTo: 'alex' });
  assert.deepEqual([c.title, c.repo, c.kind, c.phase, c.source], ['Plan project: Position End Date', 'project-planning', 'build', 'ready', { type: 'agent', by: 'factory (projects)', key: 'project:2026-10-position-end-date' }]);
  assert.deepEqual(triageCreates([C({ factoryPlan: true }, queued)], queued, {}), [], 'planned');
  assert.deepEqual(triageCreates([C({}, works)], works, {}), [], 'nothing of ours waiting to start');
  const open = { ...queued, 'W-9': { id: 'W-9', phase: 'implementation', source: { type: 'agent', by: 'factory (projects)', key: 'project:2026-10-position-end-date' } } };
  assert.deepEqual(triageCreates([C({}, open)], open, {}), [], 'one planning job at a time');
});

test("the planning job's brief keeps the work off main, names the files to write, the tasks missing test plans and where questions go", async () => {
  const { triageObjective } = await import('../core/projects.mjs');
  const unbuilt = p => ({ ...p, leaves: p.leaves.map(l => l.task === '102' ? { ...l, pr: null, work: null, state: 'not started' } : l) });
  const o = triageObjective(unbuilt(C()), { questionsTo: 'alex' });
  for (const want of [/branch alex\/factory\/2026-10-position-end-date-plan/, /never commit or push to main/i, /draft PR/, /Alex merges/,
    /projects\/2026-10-position-end-date\/factory\/implementation-plan\.md/, /factory\/decisions\.md/, /FD-001/, /built-test-plans/, /102 Import column/, /ask on this record/])
    assert.match(o, want);
  assert.doesNotMatch(o, /111 Edit modal.*missing/);
  assert.match(triageObjective(C(), { questionsTo: 'owner' }), /needs: Casey Example/);
  assert.match(triageObjective(C(), { questionsTo: 'developers' }), /needs: (Alex Bates, Casey Example|Casey Example, Alex Bates)/);
});

test('the brief plans only tasks not built yet; built ones are context, and only unbuilt ones get test plans drafted', async () => {
  const { triageObjective } = await import('../core/projects.mjs');
  const p = C(), o = triageObjective({ ...p, leaves: p.leaves.map(l => l.task === '102' ? { ...l, pr: null, work: null, state: 'not started' } : l) }, {});
  assert.match(o, /plan these 1 task\(s\): 102 Import column/);
  assert.match(o, /Already built or done \(context only\): 111 Edit modal; 112 Bulk edit/);
  assert.match(o, /Draft the missing test plans .*: 102 Import column\./);
});

// Phase D (Alex 11-16: "all of mine for now, eventually whole team's"): the team's open PRs, read-only.
const TEAM = [
  { url: PR(20), number: 20, title: 'Report column', author: 'casey-c', branch: 'casey/reports', base: 'main', isDraft: false, tasks: ['111'] },
  { url: PR(21), number: 21, title: 'Report filter', author: 'casey-c', branch: 'casey/report-filter', base: 'casey/reports', isDraft: true, tasks: [] },
  { url: PR(9), number: 9, title: 'Import column', author: 'alexbatesdev', branch: 'alex/tw-102-import', base: 'alex/tw-112-bulk-edit', isDraft: true, tasks: ['102'] },
];

test("a project task with no PR of Alex's shows a teammate's open PR that names it, with its author", () => {
  const p = buildProjects({ planning, trees: { 100: TREE.map(n => n.id === '111' ? { ...n, status: 'new' } : n) }, works, prs, teamPrs: TEAM, me: 'alexbatesdev' }).projects[0];
  assert.deepEqual([leaf(p, '111').pr?.number, leaf(p, '111').pr?.author, leaf(p, '111').state], [20, 'casey-c', 'PR open']);
  assert.equal(leaf(p, '102').pr.number, 9, "Alex's own PR still wins");
});

test("the team's other open PRs are listed by author with their stacks, Alex's own left out", () => {
  const { team } = buildProjects({ planning, trees: { 100: TREE }, works, prs, teamPrs: TEAM, me: 'alexbatesdev' });
  assert.deepEqual(team.map(p => [p.number, p.author, p.stackedOn]), [[20, 'casey-c', null], [21, 'casey-c', 20]]);
});

test("a team PR read keeps author, branch, base and the Teamwork tasks its branch or body names, not the body", async () => {
  const { readTeamPrs } = await import('../sources/github.mjs');
  const rows = [{ number: 20, title: 'Report column', url: PR(20), author: { login: 'casey-c' }, headRefName: 'casey/tw-111-reports', baseRefName: 'main', isDraft: false, body: 'Teamwork: https://acme.teamwork.com/app/tasks/112 and tasks/113' }];
  const [p] = await readTeamPrs(['app'], 'acme-org', async () => ({ stdout: JSON.stringify(rows) }));
  assert.deepEqual(p, { repo: 'app', url: PR(20), number: 20, title: 'Report column', author: 'casey-c', branch: 'casey/tw-111-reports', base: 'main', isDraft: false, tasks: ['111', '112'] });
});
