import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerequestPlan } from '../core/rerequest.mjs';

// Alex, 11-11 (W-426): once a non-approving reviewer's feedback is all addressed, the factory re-requests them, once per
// round; approvers and bots are left alone.
const PR = 'https://github.com/builtforteams/built-rails/pull/8700';
const rec = (extra = {}) => ({ 'W-1': { id: 'W-1', phase: 'awaiting_human_approval', links: { pr: PR }, rerequests: [], ...extra } });
const review = (by, state, at, commit = 'aaa') => ({ by, state, at, commit, bot: /\[bot\]$|-bot$|^chatgpt-codex-connector$/.test(by) });
const pr = (over = {}) => ({ url: PR, head: 'bbb', isDraft: false, reviews: [], threads: [], requested: [], ...over });

test('a reviewer who asked for changes is re-requested once their threads are resolved and the head moved', () => {
  const p = pr({ reviews: [review('sam-built', 'CHANGES_REQUESTED', '2026-11-11T10:00:00Z')], threads: [{ by: 'sam-built', resolved: true }, { by: 'cbprice', resolved: false }] });
  assert.deepEqual(rerequestPlan(rec(), [p]), [{ work: 'W-1', pr: PR, reviewer: 'sam-built', head: 'bbb', reviewAt: '2026-11-11T10:00:00Z', state: 'CHANGES_REQUESTED' }]);
});

test('not while one of their threads is open, nor on the head they reviewed, nor on a draft', () => {
  const r = [review('sam-built', 'COMMENTED', '2026-11-11T10:00:00Z')];
  assert.deepEqual(rerequestPlan(rec(), [pr({ reviews: r, threads: [{ by: 'sam-built', resolved: false }] })]), []);
  assert.deepEqual(rerequestPlan(rec(), [pr({ reviews: r, head: 'aaa' })]), [], 'nothing changed since their review');
  assert.deepEqual(rerequestPlan(rec(), [pr({ reviews: r, isDraft: true })]), []);
});

test('an approver is never re-requested, judged by their latest review; bots never are', () => {
  const p = pr({ reviews: [review('benny-campbell', 'CHANGES_REQUESTED', '2026-11-11T09:00:00Z'), review('benny-campbell', 'APPROVED', '2026-11-11T11:00:00Z'), review('chatgpt-codex-connector', 'COMMENTED', '2026-11-11T09:00:00Z'), review('built-engineering-bot', 'COMMENTED', '2026-11-11T09:00:00Z')] });
  assert.deepEqual(rerequestPlan(rec(), [p]), []);
});

test('once per round: not again until they review again, and not while GitHub already shows the request', () => {
  const p = pr({ reviews: [review('sam-built', 'CHANGES_REQUESTED', '2026-11-11T10:00:00Z')] });
  assert.deepEqual(rerequestPlan(rec({ rerequests: [{ reviewer: 'sam-built', reviewAt: '2026-11-11T10:00:00Z' }] }), [p]), []);
  assert.deepEqual(rerequestPlan(rec(), [{ ...p, requested: ['sam-built'] }]), []);
  const again = { ...p, reviews: [...p.reviews, review('sam-built', 'COMMENTED', '2026-11-11T12:00:00Z')] };
  assert.equal(rerequestPlan(rec({ rerequests: [{ reviewer: 'sam-built', reviewAt: '2026-11-11T10:00:00Z' }] }), [again]).length, 1, 'a new review starts a new round');
});

test('only for a PR a live record carries', () => {
  const p = pr({ reviews: [review('sam-built', 'CHANGES_REQUESTED', '2026-11-11T10:00:00Z')] });
  assert.deepEqual(rerequestPlan(rec({ phase: 'done' }), [p]), []);
});

test("the board records each re-request on the record, and the reviewer's round is remembered across replays", async () => {
  const { openStore } = await import('../core/store.mjs');
  const s = openStore(':memory:'), c = { now: '2026-11-11T13:00:00.000Z', by: 'board (re-request)' };
  const id = s.append({ kind: 'create', payload: { title: 'x', links: { pr: PR } } }, c).id;
  s.append({ kind: 'event', target: id, payload: { type: 'reviewer_rerequested', reviewer: 'sam-built', reviewAt: '2026-11-11T10:00:00Z', head: 'bbb', state: 'CHANGES_REQUESTED' } }, c);
  assert.deepEqual(s.state.work[id].rerequests.map(r => r.reviewer), ['sam-built']);
  assert.match(s.state.work[id].updates.at(-1).text, /Re-requested sam-built's review.*bbb/);
});

test("the PR author's own replies count as reviews on GitHub; the author is never re-requested", () => {
  const p = pr({ author: 'alexbatesdev', reviews: [review('alexbatesdev', 'COMMENTED', '2026-11-11T10:00:00Z')] });
  assert.deepEqual(rerequestPlan(rec(), [p]), []);
});
