// Phase 2 step 1: which spec and requirements a record is built against. Observation only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpec } from '../core/projects.mjs';

// Tree under root 100: 101 > (111, 112), 102. Another project's root is 200 with leaf 201.
const TREE = [{ id: '101', parent: '100' }, { id: '111', parent: '101' }, { id: '112', parent: '101' }, { id: '102', parent: '100' }];
const reqs = { 'REQ-001': { text: 'One.', removed: false }, 'REQ-002': { text: 'Two.', removed: false }, 'REQ-003': { text: 'Gone.', removed: true } };
const P = (over = {}) => ({ slug: 'p-end-date', readme: { teamworkTask: '100' }, spec: { teamworkTask: '100', reqs }, specBlob: 'b1', commit: 'c1',
  testPlanReqs: { 111: ['REQ-001'], 112: ['REQ-002', 'REQ-003'] }, ...over });
const Q = { slug: 'q-other', readme: { teamworkTask: '200' }, spec: { teamworkTask: '200', reqs: {} }, specBlob: 'b2', commit: 'c1', testPlanReqs: {} };
const read = (planning = [P(), Q], trees = { 100: TREE, 200: [{ id: '201', parent: '200' }] }) => ({ planning, trees });
const W = (...tasks) => ({ id: 'W-1', source: { type: 'teamwork', key: `tw-${tasks[0]}` }, aliases: tasks.slice(1).map(t => `tw-${t}`) });

test('a leaf task resolves to its project, the planning commit and spec blob, and only its test plan\'s requirements', () => {
  const r = resolveSpec(W('111'), read());
  assert.deepEqual(r, { status: 'resolved', slug: 'p-end-date', commit: 'c1', specBlob: 'b1', tasks: ['111'], reqs: { 'REQ-001': { text: 'One.', removed: false } } });
});

test('a parent task and several tasks on one PR take the union of their leaves\' requirements, removed ones kept as tombstones', () => {
  assert.deepEqual(Object.keys(resolveSpec(W('101'), read()).reqs), ['REQ-001', 'REQ-002', 'REQ-003']);
  const r = resolveSpec(W('111', '112'), read());
  assert.deepEqual([r.status, r.tasks, r.reqs['REQ-003'].removed], ['resolved', ['111', '112'], true]);
});

test('work with no Teamwork task, or a task in no project, is "no spec" and uses its own task or request', () => {
  assert.equal(resolveSpec({ id: 'W-2', source: { type: 'pr', key: 'app-9' } }, read()).status, 'no spec');
  assert.equal(resolveSpec(W('999'), read()).status, 'no spec');
});

test('tasks in two projects, or a README and spec naming different roots, are ambiguous: never the first match', () => {
  assert.equal(resolveSpec(W('111', '201'), read()).status, 'ambiguous');
  assert.equal(resolveSpec(W('111'), read([P({ spec: { teamworkTask: '300', reqs } })])).status, 'ambiguous');
  assert.equal(resolveSpec(W('111'), read([P(), P({ slug: 'p-copy' })])).status, 'ambiguous');
});

test('no planning read yet, or a project whose Teamwork tree was never read, is unavailable rather than "no spec"', () => {
  assert.equal(resolveSpec(W('111'), { planning: null, trees: {} }).status, 'unavailable');
  assert.equal(resolveSpec(W('111'), read(undefined, {})).status, 'unavailable');
  assert.equal(resolveSpec(W('100'), read(undefined, {})).status, 'resolved', 'the root itself needs no tree');
});

test('a test plan citing a REQ the spec lacks is listed as missing, not silently dropped', () => {
  assert.deepEqual(resolveSpec(W('111'), read([P({ testPlanReqs: { 111: ['REQ-001', 'REQ-009'] } }), Q])).missing, ['REQ-009']);
});

test('readPlanning reads every file at one origin/main commit and keeps the spec and its blob', async () => {
  const { readPlanning } = await import('../sources/planning.mjs');
  const calls = [];
  const files = { 'projects/p/README.md': '# P\n| Teamwork | https://x.teamwork.com/app/tasks/100 |\n', 'projects/p/spec.md': '## Requirements\n| REQ-001 | One. | |\n' };
  const run = async (_, args) => {
    const a = args.slice(2); calls.push(a.join(' '));
    if (a[0] === 'fetch') return { stdout: '' };
    if (a[0] === 'rev-parse') return { stdout: 'c0ffee\n' };
    if (a[0] === 'ls-tree' && a.includes('projects/')) return { stdout: 'projects/p\n' };
    if (a[0] === 'ls-tree' && a[1] === '-r') return { stdout: '100644 blob aaa\tprojects/p/README.md\n100644 blob bbb\tprojects/p/spec.md\n' };
    if (a[0] === 'show') { const f = a[1].replace(/^c0ffee:/, ''); if (f in files) return { stdout: files[f] }; throw new Error(`no ${a[1]}`); }
    throw new Error(`unexpected ${a.join(' ')}`);
  };
  const [p] = await readPlanning('/x', run);
  assert.deepEqual([p.commit, p.specBlob, p.reqs, Object.keys(p.spec.reqs)], ['c0ffee', 'bbb', 1, ['REQ-001']]);
  assert.ok(calls.filter(c => c.startsWith('show')).every(c => c.startsWith('show c0ffee:')), 'every read is at the pinned commit');
  await assert.rejects(readPlanning('/x', async (_, args) => { if (args[2] === 'show') throw new Error('disk'); return run(_, args); }), /disk/, 'a failed read of a file that exists is an error, not an empty file');
});

test("the record's known top-level Teamwork parent settles its project without reading every tree", () => {
  const support = { ...W('555'), project: { id: '900', name: 'Support' } };
  assert.equal(resolveSpec(support, read(undefined, {})).status, 'no spec', 'a parent no project names is no spec, even with trees unread');
  const leaf = { ...W('111'), project: { id: '100', name: 'End date' } };
  assert.deepEqual(Object.keys(resolveSpec(leaf, read(undefined, {})).reqs), ['REQ-001'], 'a task with its own test plan is a leaf without its tree');
  assert.equal(resolveSpec({ ...W('101'), project: { id: '100' } }, read(undefined, {})).status, 'unavailable', 'a parent task needs its tree for its leaves');
});

test('a leaf with no test plan is listed as untested, so zero requirements never reads as a clean contract', () => {
  assert.deepEqual(resolveSpec(W('102'), read()).untested, ['102']);
});

test('the spec view lists every open record with its resolution and counts each status', async () => {
  const { specView } = await import('../core/projects.mjs');
  const work = { a: { ...W('111'), id: 'W-1', phase: 'fixes', assignments: [{ id: 'R2', kind: 'fixes' }] }, b: { id: 'W-2', phase: 'done', source: {} }, c: { id: 'W-3', phase: 'ready', source: {} } };
  const manifests = { 'W-1/R2/1': { spec: { status: 'resolved', commit: 'c0', specBlob: 'b0', reqs: { 'REQ-001': {} } } } };
  const v = specView({ work, manifests }, read());
  assert.deepEqual([v.counts, v.rows.map(r => [r.id, r.status])], [{ resolved: 1, 'no spec': 1 }, [['W-1', 'resolved'], ['W-3', 'no spec']]]);
  assert.deepEqual(v.rows[0].pinned, { assignment: 'R2', status: 'resolved', commit: 'c0', specBlob: 'b0', reqs: ['REQ-001'] }, 'the pin its work round started with');
});

test("a project's Teamwork roots come from its README or its spec, so a spec-only root's tree is read too", async () => {
  const { projectRoots } = await import('../core/projects.mjs');
  assert.deepEqual(projectRoots({ readme: { teamworkTask: null }, spec: { teamworkTask: '300' } }), ['300']);
  assert.deepEqual(projectRoots(P()), ['100']);
});

test('a spec delta names requirements added, changed and removed since the pin; an unchanged blob is no delta', async () => {
  const { specDelta } = await import('../core/projects.mjs');
  const pin = { status: 'resolved', slug: 'p', specBlob: 'b1', reqs: { 'REQ-001': { text: 'One.', removed: false }, 'REQ-002': { text: 'Two.', removed: false }, 'REQ-003': { text: 'Three.', removed: false } } };
  assert.equal(specDelta(pin, { ...pin }), null);
  const now = { status: 'resolved', slug: 'p', specBlob: 'b2', reqs: { 'REQ-001': { text: 'One, edited.', removed: false }, 'REQ-002': { text: 'Two.', removed: true }, 'REQ-004': { text: 'Four.', removed: false } } };
  assert.deepEqual(specDelta(pin, now), { added: ['REQ-004'], changed: ['REQ-001'], removed: ['REQ-002', 'REQ-003'] });
  assert.equal(specDelta(pin, { ...now, reqs: pin.reqs }), null, 'a new blob with the same rows (an edit elsewhere in the spec) is no delta');
  assert.deepEqual(specDelta(pin, { status: 'unavailable' }), { unavailable: 'unavailable' }, 'no current read: say so, never "no change"');
  assert.equal(specDelta({ status: 'no spec' }, { status: 'no spec' }), null);
});

test('a spec delta on an enabled project becomes an in-scope finding, a question for a removal, and one note to the supervisor (phase 2)', async () => {
  const { specFollowUps } = await import('../core/projects.mjs');
  const pinReqs = { 'REQ-001': { text: 'One.', removed: false }, 'REQ-002': { text: 'Two.', removed: false } };
  const work = { 'W-1': { ...W('111', '112'), id: 'W-1', phase: 'fixes', stream: 'sup: s1', assignments: [{ id: 'R2', kind: 'fixes', status: 'started' }] } };
  const manifests = { 'W-1/R2/1': { spec: { status: 'resolved', slug: 'p-end-date', commit: 'c0', specBlob: 'b0', reqs: pinReqs } } };
  const now = read([P({ specBlob: 'b9', commit: 'c9', spec: { teamworkTask: '100', reqs: { 'REQ-001': { text: 'One, edited.', removed: false }, 'REQ-002': { text: 'Two.', removed: true }, 'REQ-003': { text: 'Gone.', removed: true } } } }), Q]);
  const state = { work, manifests, messages: {} };
  assert.deepEqual(specFollowUps(state, now, { slugs: [] }), [], 'only enabled projects');
  const cmds = specFollowUps(state, now, { slugs: ['p-end-date'] });
  const [finding, ask, msg] = cmds;
  assert.deepEqual([finding.kind, finding.target, finding.payload.type, finding.payload.inScope], ['event', 'W-1', 'discovery', true]);
  assert.match(finding.payload.text, /REQ-001 changed.*One, edited\./);
  assert.deepEqual([ask.kind, ask.payload.work], ['ask', 'W-1']);
  assert.match(ask.payload.title, /REQ-002/);
  assert.deepEqual([msg.kind, msg.payload.to, msg.payload.about.specDelta.map(k => k.replace(/:[0-9a-f]{10}$/, ':h'))], ['message', 'sup: s1', ['W-1/R2/REQ-001:h', 'W-1/R2/REQ-002:removed']]);
  assert.match(msg.payload.text, /R2's brief stands/);
  // Told once per assignment and spec version.
  assert.deepEqual(specFollowUps({ ...state, messages: { m: { about: msg.payload.about } } }, now, { slugs: ['p-end-date'] }), []);
});

test('the spec follow-up commands are accepted by the store, and the removal question can be answered', async () => {
  const { specFollowUps } = await import('../core/projects.mjs');
  const { openStore } = await import('../core/store.mjs');
  const store = openStore(':memory:', { supervisors: ['sup: s1'] });
  const c = { now: '2026-11-18T19:00:00.000Z', by: 'factory (spec)' };
  store.append({ kind: 'create', payload: { title: 'x', stream: 'sup: s1', source: { type: 'teamwork', key: 'tw-111' } } }, c);
  const w = store.state.work['W-1'];
  Object.assign(w, { stream: 'sup: s1', phase: 'fixes', assignments: [{ id: 'R2', kind: 'fixes', status: 'started', history: [] }] });
  store.state.manifests = { 'W-1/R2/1': { spec: { status: 'resolved', slug: 'p-end-date', commit: 'c0', specBlob: 'b0', reqs: { 'REQ-001': { text: 'One.', removed: false } } } } };
  const now = read([P({ specBlob: 'b9', spec: { teamworkTask: '100', reqs: { 'REQ-001': { text: 'One.', removed: true } } } }), Q]);
  const cmds = specFollowUps(store.state, now, { slugs: ['p-end-date'] });
  for (const cmd of cmds) store.append(cmd, c);
  const [q] = Object.entries(store.state.questions);
  store.append({ kind: 'answer', target: q[0], payload: { choice: 'rec' } }, { ...c, by: 'local-head' });
  assert.equal(store.state.questions[q[0]].answer.choice, 'a');
  assert.deepEqual(specFollowUps(store.state, now, { slugs: ['p-end-date'] }), [], 'told once');
});

test('a later spec edit files only what is new: each requirement change is told once, whatever the spec blob (phase 2)', async () => {
  const { specFollowUps } = await import('../core/projects.mjs');
  const work = { 'W-1': { ...W('111'), id: 'W-1', phase: 'fixes', stream: 'sup: s1', assignments: [{ id: 'R2', kind: 'fixes', status: 'started' }] } };
  const manifests = { 'W-1/R2/1': { spec: { status: 'resolved', slug: 'p-end-date', commit: 'c0', specBlob: 'b0', reqs: { 'REQ-001': { text: 'One.', removed: false } } } } };
  const at = (blob, text) => read([P({ specBlob: blob, spec: { teamworkTask: '100', reqs: { 'REQ-001': { text, removed: false } } } }), Q]);
  const state = { work, manifests, messages: {} };
  const first = specFollowUps(state, at('b9', 'One, edited.'), { slugs: ['p-end-date'] });
  state.messages.m1 = first.at(-1).payload;
  assert.deepEqual(specFollowUps(state, at('b10', 'One, edited.'), { slugs: ['p-end-date'] }), [], 'an unrelated edit elsewhere in the spec');
  const again = specFollowUps(state, at('b11', 'One, edited twice.'), { slugs: ['p-end-date'] });
  assert.equal(again.length, 2, 'a second edit to the same requirement is new');
  assert.match(again[0].payload.text, /edited twice/);
});

test("the removal question quotes the requirement's pinned text, so it can be answered without opening the spec", async () => {
  const { specFollowUps } = await import('../core/projects.mjs');
  const work = { 'W-1': { ...W('111'), id: 'W-1', phase: 'fixes', stream: 'sup: s1', assignments: [{ id: 'R2', kind: 'fixes', status: 'started' }] } };
  const manifests = { 'W-1/R2/1': { spec: { status: 'resolved', slug: 'p-end-date', commit: 'c0', specBlob: 'b0', reqs: { 'REQ-001': { text: 'One.', removed: false } } } } };
  const [ask] = specFollowUps({ work, manifests, messages: {} }, read([P({ specBlob: 'b9', spec: { teamworkTask: '100', reqs: { 'REQ-001': { text: 'One.', removed: true } } } }), Q]), { slugs: ['p-end-date'] });
  assert.match(ask.payload.promptedBy, /REQ-001 was: "One\."/);
});

test("a project task's dispatch note names the plan, its test plan and the requirements it is built against (phase 2 step 4)", async () => {
  const { projectNote } = await import('../core/projects.mjs');
  const r = { status: 'resolved', slug: 'p', commit: 'abcdef1234', reqs: { 'REQ-001': { removed: false }, 'REQ-003': { removed: true } } };
  const n = projectNote({ slug: 'p' }, { testPlanPath: 'projects/p/test-plans/111-x.md' }, r);
  assert.match(n, /projects\/p\/factory\/implementation-plan\.md.*projects\/p\/test-plans\/111-x\.md/);
  assert.match(n, /Requirements: REQ-001 \(projects\/p\/spec\.md at abcdef1\)\. REQ-003 was removed from the spec: don't build it\./);
  assert.match(projectNote({ slug: 'p' }, {}, { status: 'ambiguous', reason: 'two projects' }), /Spec: ambiguous \(two projects\): build from the task and ask your supervisor/);
});
