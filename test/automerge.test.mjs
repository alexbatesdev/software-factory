// W-564 (Alex 11-18): auto-merge for our PRs with no project and no hold, at his bar: 2 human approvals (1 QA + 1 dev)
// on the current head, nothing open. Neutral names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoMergePlan } from '../core/automerge.mjs';

const URL = 'https://github.com/acme-org/app/pull/7', H = 'a'.repeat(40);
const rec = (over = {}) => ({ id: 'W-1', phase: 'awaiting_human_approval', head: H, links: { pr: URL }, findings: [], externalDeps: [], waitingOn: null, ...over });
const pr = (over = {}) => ({ url: URL, state: 'OPEN', isDraft: false, base: 'main', head: H, author: 'me', reviewDecision: 'APPROVED', unresolvedThreads: 0, autoMerge: false,
  approvals: [{ by: 'qa-1', commit: H }, { by: 'dev-1', commit: H }], ...over });
const teams = { qa: ['qa-1'], devs: ['dev-1', 'dev-2', 'qa-1'] };
const plan = (r = rec(), p = pr(), extra = {}) => autoMergePlan([r], new Map([[URL, p]]), { me: 'me', ...teams, spec: () => ({ status: 'no spec' }), ...extra });

test('a ready PR of ours with a QA and a dev approval on its head, no project and nothing open, gets auto-merge', () => {
  assert.deepEqual(plan().map(x => [x.work, x.action]), [['W-1', 'enable']]);
});

test('anything short of the bar is not enabled, and says why', () => {
  const why = (r, p, e) => { const x = plan(r, p, e); assert.equal(x[0]?.action ?? 'none', 'none'); return x[0]?.reason; };
  assert.match(why(rec(), pr({ approvals: [{ by: 'qa-1', commit: H }] })), /dev approval/);
  assert.match(why(rec(), pr({ approvals: [{ by: 'dev-1', commit: H }, { by: 'dev-2', commit: H }] })), /QA approval/);
  assert.match(why(rec(), pr({ approvals: [{ by: 'qa-1', commit: 'b'.repeat(40) }, { by: 'dev-1', commit: H }] })), /QA approval/, 'an approval of an older commit does not count');
  assert.match(why(rec(), pr(), { spec: () => ({ status: 'resolved', slug: 'p' }) }), /project p/);
  assert.match(why(rec({ externalDeps: [{ text: 'product says when' }] })), /hold/);
  assert.match(why(rec({ waitingOn: { who: 'x', what: 'y' } })), /hold/);
  assert.match(why(rec({ findings: [{ status: 'open' }] })), /open finding/);
  assert.match(why(rec({ phase: 'fixes' })), /awaiting approval/);
  assert.match(why(rec(), pr({ base: 'feature-x' })), /base/);
  assert.match(why(rec(), pr({ author: 'someone' })), /not ours/);
  assert.match(why(rec(), pr({ reviewDecision: 'CHANGES_REQUESTED' })), /changes requested/);
  assert.match(why(rec(), pr({ unresolvedThreads: 2 })), /thread/);
  assert.match(why(rec(), pr({ isDraft: true })), /draft/);
  assert.match(why(rec({ head: 'c'.repeat(40) })), /head/, 'the record and GitHub disagree on the head');
});

test('the same approver is not both the QA and the dev approval', () => {
  assert.equal(plan(rec(), pr({ approvals: [{ by: 'qa-1', commit: H }] }))[0]?.action ?? 'none', 'none');
});

test('auto-merge already on is turned off once the PR stops qualifying, and left alone while it still does', () => {
  assert.deepEqual(plan(rec(), pr({ autoMerge: true })), []);
  assert.deepEqual(plan(rec({ findings: [{ status: 'open' }] }), pr({ autoMerge: true })).map(x => x.action), ['disable']);
  assert.deepEqual(plan(rec(), pr({ autoMerge: true, approvals: [] })).map(x => x.action), ['disable']);
});
