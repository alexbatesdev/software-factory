// W-564 (Alex 11-18): auto-merge is for small, quick fixes (security fixes and the like), where one approval is enough.
// The factory turns it on for our main-targeted PR, marked ready after its internal review, with no project and no hold;
// GitHub's own ruleset decides when it merges. Enabling auto-merge is not a merge. Neutral names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMergePlan } from '../core/automerge.mjs';

const URL = 'https://github.com/acme-org/app/pull/7', H = 'a'.repeat(40);
const rec = (over = {}) => ({ id: 'W-1', phase: 'awaiting_human_approval', head: H, links: { pr: URL }, findings: [], externalDeps: [], waitingOn: null, ...over });
const pr = (over = {}) => ({ url: URL, state: 'OPEN', isDraft: false, base: 'main', head: H, author: 'me', reviewDecision: 'REVIEW_REQUIRED', autoMerge: false, approvals: [], ...over });
const plan = (r = rec(), p = pr(), extra = {}) => autoMergePlan([r], new Map([[URL, p]]), { me: 'me', spec: () => ({ status: 'no spec' }), ...extra });

test('our ready PR on main with no project and no hold gets auto-merge before any approval: GitHub decides when it merges', () => {
  assert.deepEqual(plan().map(x => [x.work, x.action]), [['W-1', 'enable']]);
  assert.match(plan()[0].reason, /small, quick fix/);
});

test('work tied to a project or a hold, or not ready, keeps the usual merge, and says why', () => {
  const why = (r, p, e) => { const x = plan(r, p, e); assert.equal(x[0]?.action ?? 'none', 'none'); return x[0]?.reason; };
  assert.match(why(rec(), pr(), { spec: () => ({ status: 'resolved', slug: 'p' }) }), /project p/);
  assert.match(why(rec(), pr(), { spec: () => ({ status: 'unavailable' }) }), /project is unavailable/, 'an unknown project is not "no project"');
  assert.match(why(rec({ externalDeps: [{ text: 'product says when' }] })), /hold/);
  assert.match(why(rec({ waitingOn: { who: 'x', what: 'y' } })), /hold/);
  assert.match(why(rec({ phase: 'fixes' })), /awaiting approval/);
  assert.match(why(rec(), pr({ base: 'feature-x' })), /base/);
  assert.match(why(rec(), pr({ author: 'someone' })), /not ours/);
  assert.match(why(rec(), pr({ reviewDecision: 'CHANGES_REQUESTED' })), /changes requested/);
  assert.match(why(rec(), pr({ isDraft: true })), /draft/);
  assert.match(why(rec({ head: 'c'.repeat(40) })), /head/);
});

test('auto-merge already on is left alone while the PR qualifies, and turned off when a hold or a changes request arrives', () => {
  assert.deepEqual(plan(rec(), pr({ autoMerge: true })), []);
  assert.deepEqual(plan(rec({ externalDeps: [{ text: 'hold' }] }), pr({ autoMerge: true })).map(x => x.action), ['disable']);
  assert.deepEqual(plan(rec(), pr({ autoMerge: true, reviewDecision: 'CHANGES_REQUESTED' })).map(x => x.action), ['disable']);
});

test('a PR already mergeable is left for Alex: GitHub takes no auto-merge on it, and merging it is his (W-564: #8906)', () => {
  const x = plan(rec(), pr({ mergeState: 'CLEAN' }));
  assert.equal(x[0]?.action ?? 'none', 'none');
  assert.match(x[0].reason, /already mergeable/);
});

test('turning auto-merge on is the enablePullRequestAutoMerge mutation, never `gh pr merge`, which merges a mergeable PR outright (#8906)', async () => {
  const { gh } = await import('../effects/github.mjs');
  const calls = [], run = async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: JSON.stringify(args.includes('--jq') ? 'PR_node1' : { data: {} }) }; };
  await gh.autoMerge('https://github.com/acme-org/app/pull/7', true, run);
  await gh.autoMerge('https://github.com/acme-org/app/pull/7', false, run);
  assert.ok(calls.every(c => !(c.includes('pr') && c.includes('merge'))), 'no gh pr merge');
  const muts = calls.map(c => c.join(' ')).filter(c => /mutation/.test(c));
  assert.match(muts[0], /enablePullRequestAutoMerge\(input:\{pullRequestId:\$id,mergeMethod:MERGE\}\)/);
  assert.match(muts[1], /disablePullRequestAutoMerge/);
});

test("auto-merge someone else turned off stays off: the factory turned it on once and never again on that PR (#8569)", () => {
  const on = { at: '2026-11-18T22:19:57Z', by: 'factory (auto-merge)', text: `GitHub auto-merge turned on for ${URL}: a small fix (W-564).` };
  const x = plan(rec({ updates: [on] }), pr({ autoMerge: false }));
  assert.equal(x[0]?.action ?? 'none', 'none');
  assert.match(x[0].reason, /turned off by someone/);
  const off = { at: '2026-11-18T22:25:00Z', by: 'factory (auto-merge)', text: `GitHub auto-merge turned off for ${URL}: a hold is on the record (W-564).` };
  assert.equal(plan(rec({ updates: [on, off] }), pr())[0].action, 'enable', 'after the factory itself turned it off, it may turn it on again');
});

test('only a small fix gets auto-merge: over 10 files or 300 changed lines keeps the usual merge, and loses auto-merge if it has it (Alex 11-18)', () => {
  const x = plan(rec(), pr({ changedFiles: 8, additions: 400, deletions: 61 }));
  assert.equal(x[0]?.action ?? 'none', 'none');
  assert.match(x[0].reason, /461 changed lines/);
  assert.match(plan(rec(), pr({ changedFiles: 11, additions: 10, deletions: 0 }))[0].reason, /11 files/);
  assert.equal(plan(rec(), pr({ changedFiles: 10, additions: 200, deletions: 100 }))[0].action, 'enable', 'at the limit is small');
  assert.equal(plan(rec(), pr({ changedFiles: 25, additions: 900, deletions: 117, autoMerge: true }))[0].action, 'disable');
  assert.equal(plan(rec(), pr({}))[0].action, 'enable', 'a size not read yet does not hold it');
});

test("a merge hold (waiting on product's answer) keeps auto-merge off and turns it off if on, without holding the record's work (W-572)", async () => {
  const held = rec({ mergeHold: { why: 'product question to Casey on the PR', at: 't', by: 'factory-developer' } });
  assert.match(plan(held, pr())[0].reason, /merge hold: product question to Casey/);
  assert.equal(plan(held, pr())[0].action, null);
  assert.equal(plan(held, pr({ autoMerge: true }))[0].action, 'disable');
  const { autoDispatchPlan } = await import('../core/dispatch.mjs');
  const S = 'sup: s1', job = { id: 'W-1', title: 'x', phase: 'fixes', priority: 3, stream: S, owner: S, streamPin: { by: 't' }, openQuestions: 0, openDeps: [], externalDeps: [], links: {}, head: 'h1',
    mergeHold: held.mergeHold, assignments: [{ id: 'R1', kind: 'implementation', status: 'done' }], requests: [{ id: 'R5', type: 'fixes', ack: null, head: 'h1', delivery: 'pending' }] };
  assert.equal(autoDispatchPlan([job], { supervisors: { [S]: {} } })[0].action, 'deliver', 'its fixes round still goes out');
});

test('a merge hold is set and released by an event, each noted on the record (W-572)', async () => {
  const { openStore } = await import('../core/store.mjs');
  const { commandsFor } = await import('../core/actions.mjs');
  const s = openStore(':memory:', { supervisors: [] }), c = by => ({ now: '2026-11-19T18:30:00Z', by });
  s.append({ kind: 'create', payload: { title: 'x' } }, c('t'));
  for (const cmd of commandsFor('merge_hold', { work: 'W-1', why: 'waiting on product (Casey) on the PR' })) s.append(cmd, c('factory-developer'));
  assert.equal(s.state.work['W-1'].mergeHold.why, 'waiting on product (Casey) on the PR');
  for (const cmd of commandsFor('merge_hold', { work: 'W-1', why: 'Casey answered: ship it', release: true })) s.append(cmd, c('local-head'));
  assert.equal(s.state.work['W-1'].mergeHold, null);
  assert.match(s.state.work['W-1'].updates.at(-1).text, /Merge hold released: Casey answered/);
});

test('a draft hold keeps a reviewed PR draft: the standing ready tick refuses it until the hold is released (W-641)', async () => {
  const { openStore } = await import('../core/store.mjs');
  const { commandsFor } = await import('../core/actions.mjs');
  const { prReadyPreflight } = await import('../core/work.mjs');
  const { waitingOn } = await import('../core/derive.mjs');
  const s = openStore(':memory:', { supervisors: [] }), c = by => ({ now: '2026-11-21T02:10:00Z', by });
  s.append({ kind: 'create', payload: { title: 'x' } }, c('t'));
  for (const cmd of commandsFor('merge_hold', { work: 'W-1', why: 'Alex: stays draft until Casey answers on #8922', draft: true })) s.append(cmd, c('factory-developer'));
  const w = { ...s.state.work['W-1'], phase: 'ready_for_human' };
  assert.ok(prReadyPreflight(w, null).some(r => /Kept draft: Alex: stays draft until Casey answers/.test(r)));
  assert.match(w.updates.at(-1).text, /Draft hold: .*stays draft/);
  assert.match(waitingOn(w).text, /^Kept draft: Alex: stays draft/);
  for (const cmd of commandsFor('merge_hold', { work: 'W-1', why: 'Casey answered', release: true })) s.append(cmd, c('local-head'));
  assert.ok(!prReadyPreflight({ ...s.state.work['W-1'], phase: 'ready_for_human' }, null).some(r => /Kept draft/.test(r)));
});
