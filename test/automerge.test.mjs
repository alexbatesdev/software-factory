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
