import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rerequestPlan } from '../core/rerequest.mjs';

// Alex, 11-11 (W-426): once a non-approving reviewer's feedback is all addressed, the factory re-requests them, once per
// round; approvers and bots are left alone.
const PR = 'https://github.com/acme-org/app/pull/8700';
const rec = (extra = {}) => ({ 'W-1': { id: 'W-1', phase: 'awaiting_human_approval', links: { pr: PR }, rerequests: [], ...extra } });
const review = (by, state, at, commit = 'aaa') => ({ by, state, at, commit, bot: /\[bot\]$|-bot$|^chatgpt-codex-connector$/.test(by) });
const pr = (over = {}) => ({ url: PR, head: 'bbb', isDraft: false, reviews: [], threads: [], requested: [], ...over });

test('a reviewer who asked for changes is re-requested once their threads are resolved and the head moved', () => {
  const p = pr({ reviews: [review('reviewer-sam', 'CHANGES_REQUESTED', '2026-11-11T10:00:00Z')], threads: [{ by: 'reviewer-sam', resolved: true }, { by: 'reviewer-cb', resolved: false }] });
  assert.deepEqual(rerequestPlan(rec(), [p]), [{ work: 'W-1', pr: PR, reviewer: 'reviewer-sam', head: 'bbb', reviewAt: '2026-11-11T10:00:00Z', state: 'CHANGES_REQUESTED' }]);
});

test('not while one of their threads is open, nor on the head they reviewed, nor on a draft', () => {
  const r = [review('reviewer-sam', 'COMMENTED', '2026-11-11T10:00:00Z')];
  assert.deepEqual(rerequestPlan(rec(), [pr({ reviews: r, threads: [{ by: 'reviewer-sam', resolved: false }] })]), []);
  assert.deepEqual(rerequestPlan(rec(), [pr({ reviews: r, head: 'aaa' })]), [], 'nothing changed since their review');
  assert.deepEqual(rerequestPlan(rec(), [pr({ reviews: r, isDraft: true })]), []);
});

test('an approver is never re-requested, judged by their latest review; bots never are', () => {
  const p = pr({ reviews: [review('reviewer-bc', 'CHANGES_REQUESTED', '2026-11-11T09:00:00Z'), review('reviewer-bc', 'APPROVED', '2026-11-11T11:00:00Z'), review('chatgpt-codex-connector', 'COMMENTED', '2026-11-11T09:00:00Z'), review('built-engineering-bot', 'COMMENTED', '2026-11-11T09:00:00Z')] });
  assert.deepEqual(rerequestPlan(rec(), [p]), []);
});

test('once per round: not again until they review again, and not while GitHub already shows the request', () => {
  const p = pr({ reviews: [review('reviewer-sam', 'CHANGES_REQUESTED', '2026-11-11T10:00:00Z')] });
  assert.deepEqual(rerequestPlan(rec({ rerequests: [{ reviewer: 'reviewer-sam', reviewAt: '2026-11-11T10:00:00Z' }] }), [p]), []);
  assert.deepEqual(rerequestPlan(rec(), [{ ...p, requested: ['reviewer-sam'] }]), []);
  const again = { ...p, reviews: [...p.reviews, review('reviewer-sam', 'COMMENTED', '2026-11-11T12:00:00Z')] };
  assert.equal(rerequestPlan(rec({ rerequests: [{ reviewer: 'reviewer-sam', reviewAt: '2026-11-11T10:00:00Z' }] }), [again]).length, 1, 'a new review starts a new round');
});

test('only for a PR a live record carries', () => {
  const p = pr({ reviews: [review('reviewer-sam', 'CHANGES_REQUESTED', '2026-11-11T10:00:00Z')] });
  assert.deepEqual(rerequestPlan(rec({ phase: 'done' }), [p]), []);
});

test("the board records each re-request on the record, and the reviewer's round is remembered across replays", async () => {
  const { openStore } = await import('../core/store.mjs');
  const s = openStore(':memory:'), c = { now: '2026-11-11T13:00:00.000Z', by: 'board (re-request)' };
  const id = s.append({ kind: 'create', payload: { title: 'x', links: { pr: PR } } }, c).id;
  s.append({ kind: 'event', target: id, payload: { type: 'reviewer_rerequested', reviewer: 'reviewer-sam', reviewAt: '2026-11-11T10:00:00Z', head: 'bbb', state: 'CHANGES_REQUESTED' } }, c);
  assert.deepEqual(s.state.work[id].rerequests.map(r => r.reviewer), ['reviewer-sam']);
  assert.match(s.state.work[id].updates.at(-1).text, /Re-requested reviewer-sam's review.*bbb/);
});

test("the PR author's own replies count as reviews on GitHub; the author is never re-requested", () => {
  const p = pr({ author: 'alexbatesdev', reviews: [review('alexbatesdev', 'COMMENTED', '2026-11-11T10:00:00Z')] });
  assert.deepEqual(rerequestPlan(rec(), [p]), []);
});

test('only a recent round is re-requested: a review older than the window is left alone (Alex, 11-11: recent reviews only)', () => {
  const p = pr({ reviews: [review('reviewer-sam', 'COMMENTED', '2026-10-22T19:11:37Z'), review('reviewer-cb', 'CHANGES_REQUESTED', '2026-11-09T10:00:00Z')] });
  const got = rerequestPlan(rec(), [p], { now: Date.parse('2026-11-11T23:00:00Z'), maxAgeMs: 7 * 86400000 });
  assert.deepEqual(got.map(r => r.reviewer), ['reviewer-cb']);
});

// W-521 (11-16): reviewer-bc's #8876 review was a body with no threads and nobody answered it; he was re-requested anyway
// and said so publicly. A reviewer is re-requested only once everything they said has an answer from the author.
test('never over an unanswered review body: the author must have commented on the PR after it', () => {
  const r = [{ ...review('reviewer-bc', 'COMMENTED', '2026-11-16T20:00:00Z'), body: 'A couple of concerns about the sync order.' }];
  assert.deepEqual(rerequestPlan(rec(), [pr({ author: 'alex', reviews: r, comments: [] })]), []);
  assert.deepEqual(rerequestPlan(rec(), [pr({ author: 'alex', reviews: r, comments: [{ by: 'alex', at: '2026-11-16T19:00:00Z' }] })]), [], 'a comment from before the review is no answer');
  assert.equal(rerequestPlan(rec(), [pr({ author: 'alex', reviews: r, comments: [{ by: 'alex', at: '2026-11-16T21:00:00Z' }] })]).length, 1);
});

test("never while the reviewer has a PR comment newer than the author's last one, or a thread whose last word is theirs, resolved or not", () => {
  const r = [review('reviewer-bc', 'COMMENTED', '2026-11-16T20:00:00Z')];
  assert.deepEqual(rerequestPlan(rec(), [pr({ author: 'alex', reviews: r, comments: [{ by: 'alex', at: '2026-11-16T21:00:00Z' }, { by: 'reviewer-bc', at: '2026-11-16T22:00:00Z' }] })]), []);
  assert.deepEqual(rerequestPlan(rec(), [pr({ author: 'alex', reviews: r, threads: [{ by: 'reviewer-bc', resolved: true, lastBy: 'reviewer-bc' }] })]), [], 'resolved without a reply is not answered');
  assert.equal(rerequestPlan(rec(), [pr({ author: 'alex', reviews: r, threads: [{ by: 'reviewer-bc', resolved: true, lastBy: 'alex' }] })]).length, 1);
});
