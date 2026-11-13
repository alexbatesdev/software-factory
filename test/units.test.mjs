import { DEFAULT_REPO } from '../core/work.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prKey, isPrUnit, unitsOf, groupIndex } from '../core/units.mjs';

const PR = n => `https://github.com/acme-org/app/pull/${n}`;
const works = {
  'W-86': { id: 'W-86', kind: 'pr-feedback', source: { type: 'pr', key: 'app-8244' }, links: { pr: PR(8244) } },
  'W-75': { id: 'W-75', kind: 'build', source: { type: 'agent' }, links: { pr: PR(8355) } },
  'W-60': { id: 'W-60', kind: 'build', source: { type: 'teamwork', key: 'tw-1' }, links: { pr: PR(8244) } },
  'W-85': { id: 'W-85', kind: 'build', source: { type: 'teamwork', key: 'tw-2' }, links: {}, related: [{ to: 'W-86', kind: 'same-work' }] },
  'W-44': { id: 'W-44', kind: 'build', source: { type: 'teamwork', key: 'tw-3' }, links: { pr: PR(8244) }, coverage: { state: 'open-pr', prs: [{ url: PR(8355) }] } },
  'W-41': { id: 'W-41', kind: 'build', source: { type: 'teamwork', key: 'tw-4' }, links: { pr: PR(8239) } },
  'W-9': { id: 'W-9', kind: 'build', source: { type: 'teamwork', key: 'tw-5' }, links: {} },
  'W-120': { id: 'W-120', kind: 'build', source: { type: 'agent' }, links: {}, parent: 'W-86' },
};
const bySource = { 'app-8244': 'W-86', 'app-8355': 'W-75', 'app-8239': 'W-41' };

test('a PR unit is the PR-shaped record holding the PR; a task holding a PR key is not one', () => {
  assert.equal(prKey(PR(8244)), 'app-8244');
  assert.deepEqual(['W-86', 'W-75', 'W-60', 'W-41'].map(id => isPrUnit(works[id], bySource)), [true, true, false, false]);
});

test('a task belongs to every PR it is implemented in: link, open-pr coverage or same-work', () => {
  assert.deepEqual(unitsOf(works['W-60'], works, bySource), ['W-86']);
  assert.deepEqual(unitsOf(works['W-85'], works, bySource), ['W-86']);
  assert.deepEqual(unitsOf(works['W-44'], works, bySource).sort(), ['W-75', 'W-86']);
  assert.deepEqual(unitsOf(works['W-9'], works, bySource), [], 'no PR yet: its own card');
  assert.deepEqual(unitsOf(works['W-86'], works, bySource), [], 'a unit is never a member');
});

test('the group index lists each unit\'s members and children once', () => {
  const g = groupIndex(works, bySource);
  assert.deepEqual(g.members['W-86'].sort(), ['W-44', 'W-60', 'W-85']);
  assert.deepEqual(g.members['W-75'], ['W-44']);
  assert.deepEqual(g.children['W-86'], ['W-120']);
  assert.deepEqual(g.unitsOf['W-44'].sort(), ['W-75', 'W-86']);
});

import { mergeCloses } from '../core/units.mjs';
test('a merged PR closes its unit; a task closes only when every PR it is in has merged', () => {
  const pr = { [PR(8244)]: 'MERGED', [PR(8355)]: 'OPEN' };
  const close = (ws, extra = {}) => mergeCloses(ws, bySource, { prState: u => pr[u] || null, openQuestions: id => extra.q?.[id] || 0, track: w => /mutation/.test(w.links?.branch || '') ? 'mutation' : 'stream' }).map(c => c.id).sort();
  assert.deepEqual(close(works), ['W-60', 'W-85', 'W-86'], 'W-44 is also in the still-open #8355');
  pr[PR(8355)] = 'MERGED';
  assert.ok(close(works).includes('W-44'));
  assert.ok(!close({ ...works, 'W-86': { ...works['W-86'], phase: 'done' } }).includes('W-86'));
});

test("Alex merging past a wait or an open question closes the record and names what was outstanding; partial coverage is raised instead (W-248)", () => {
  const pr = { [PR(8244)]: 'MERGED', [PR(8355)]: 'OPEN' };
  const run = (ws, q = {}) => mergeCloses(ws, bySource, { prState: u => pr[u] || null, openQuestions: id => q[id] || 0, track: () => 'stream' });
  const waited = run({ ...works, 'W-60': { ...works['W-60'], waitingOn: { who: 'QA', what: 'a test pass' } } }, { 'W-85': 1 });
  assert.match(waited.find(c => c.id === 'W-60').outstanding.join(' '), /QA: a test pass/);
  assert.match(waited.find(c => c.id === 'W-85').outstanding.join(' '), /1 open question/);
  const partial = run({ ...works, 'W-60': { ...works['W-60'], coverage: { state: 'partial' } } }).find(c => c.id === 'W-60');
  assert.equal(partial.raise, true, 'work left beyond the PR: Alex hears, the record stays open');
});

test('a task record that holds its own PR, with no PR record of its own, closes when that PR merges (W-149 #8487)', () => {
  const ws = { 'W-149': { id: 'W-149', phase: 'fixes', source: { type: 'teamwork', key: 'tw-1' }, links: { pr: PR(8487) } } };
  const run = state => mergeCloses(ws, { 'tw-1': 'W-149', 'app-8487': 'W-149' }, { prState: u => state, openQuestions: () => 0, track: () => 'stream' });
  assert.deepEqual(run('MERGED').map(c => [c.id, c.prs]), [['W-149', [PR(8487)]]]);
  assert.deepEqual(run('OPEN'), []);
});

import { holdReleases } from '../core/units.mjs';
test('a merge hold is released when its PR merges, and only then', () => {
  const ws = { 'W-1': { id: 'W-1', phase: 'intake', repo: null, externalDeps: [{ pr: '#8606' }, { text: 'a person' }] }, 'W-2': { id: 'W-2', phase: 'done', externalDeps: [{ pr: '#8606' }] } };
  const url = `https://github.com/acme-org/${DEFAULT_REPO}/pull/8606`;
  assert.deepEqual(holdReleases(ws, 'acme-org').urls, [url]);
  assert.deepEqual(holdReleases(ws, 'acme-org', u => (u === url ? 'MERGED' : null)).released, [{ id: 'W-1', pr: '#8606' }]);
  assert.deepEqual(holdReleases(ws, 'acme-org', () => 'OPEN').released, []);
  assert.deepEqual(holdReleases(ws, 'acme-org', () => 'CLOSED').released, []);
  assert.deepEqual(holdReleases(ws, 'acme-org', () => 'CLOSED').closed, [{ id: 'W-1', pr: '#8606' }], 'a PR closed unmerged is reported, never released');
});

import { questionHolds } from '../core/units.mjs';
test('a question hold is released when Alex answers, and reported (never released) when the question is closed unanswered', () => {
  const ws = { 'W-1': { id: 'W-1', phase: 'intake', externalDeps: [{ question: 'TB-7' }] }, 'W-2': { id: 'W-2', phase: 'intake', externalDeps: [{ question: 'TB-8' }] } };
  const qs = status => ({ 'TB-7': { status }, 'TB-8': { status: 'open' } });
  assert.deepEqual(questionHolds(ws, qs('answered')).released, [{ id: 'W-1', question: 'TB-7' }]);
  assert.deepEqual(questionHolds(ws, qs('open')).released, []);
  assert.deepEqual(questionHolds(ws, qs('superseded')).closed, [{ id: 'W-1', question: 'TB-7' }]);
  assert.deepEqual(questionHolds(ws, qs('superseded')).released, []);
});

import { watchedPrs } from '../core/units.mjs';
test("the poll reads every PR a live record's merge-close depends on, including a finished unit's (W-51: #8265's record was done, so the task never closed)", () => {
  const PR = n => `https://github.com/acme-org/app/pull/${n}`;
  const ws = { 'W-51': { id: 'W-51', phase: 'awaiting_human_approval', links: { pr: PR(8282) }, coverage: { state: 'open-pr', prs: [{ url: PR(8265) }, { url: PR(8282) }] } }, 'W-99': { id: 'W-99', phase: 'done', parent: 'W-51', links: { pr: PR(8282) }, source: { type: 'pr', key: 'app-8282' } },
    'W-101': { id: 'W-101', phase: 'done', parent: 'W-51', links: { pr: PR(8265) }, source: { type: 'pr', key: 'app-8265' } }, 'W-7': { id: 'W-7', phase: 'done', links: { pr: PR(1) } } };
  const bySource = { 'app-8282': 'W-99', 'app-8265': 'W-101' };
  assert.deepEqual(watchedPrs(ws, bySource).sort(), [PR(8265), PR(8282)]);
});

import { derivedCtx } from '../core/store.mjs';
test('a job parked on a PR clears only once that PR merges, and the PR is polled (W-317 phase 2)', () => {
  const url = `https://github.com/acme-org/${DEFAULT_REPO}/pull/8606`;
  const job = waitingOn => ({ id: 'W-1', phase: 'implementation', assignments: [{ id: 'R1', kind: 'implementation', status: 'blocked', version: 2, waitingOn }] });
  const state = waitingOn => ({ work: { 'W-1': job(waitingOn) }, questions: {} });
  const cleared = (waitingOn, prState) => derivedCtx(state(waitingOn), 'W-1', { owner: 'acme-org', prState })?.parked[0];
  assert.equal(cleared('#8606', u => (u === url ? 'MERGED' : null)).cleared, true);
  assert.match(cleared('#8606', u => (u === url ? 'MERGED' : null)).why, /#8606 merged/);
  assert.equal(cleared(url, u => (u === url ? 'MERGED' : null)).cleared, true, 'a full PR URL works too');
  assert.equal(cleared('#8606', () => 'OPEN').cleared, false, 'still open: stays parked');
  assert.equal(cleared('#8606', () => 'CLOSED').cleared, false, 'closed unmerged never releases');
  assert.equal(cleared('#8606').cleared, false, 'no fresh PR read: stays parked');
  assert.deepEqual(holdReleases({ 'W-1': job('#8606') }, 'acme-org').urls, [url], 'the poll reads the PR it waits on');
});

import { reviewsDue } from '../core/units.mjs';
test('a hold whose review date passed is due for its reviewer; it is never released (W-317 phase 4)', () => {
  const held = (id, by, phase = 'intake') => ({ id, phase, externalDeps: [{ ref: `review ${by}`, review: { by, reviewer: 'board lead' }, text: `review by ${by} (board lead)` }] });
  const ws = { 'W-1': held('W-1', '2026-11-08'), 'W-2': held('W-2', '2026-11-20'), 'W-3': held('W-3', '2026-11-01', 'done') };
  assert.deepEqual(reviewsDue(ws, '2026-11-09T10:00:00Z'), [{ id: 'W-1', by: '2026-11-08', reviewer: 'board lead' }]);
});

import { contradictions } from '../core/units.mjs';
test('the audit names each contradiction once per record and kind, with evidence and a next action (W-317 phase 5)', () => {
  const now = '2026-11-10T12:00:00.000Z', old = '2026-11-09T00:00:00.000Z', PR = 'https://github.com/o/r/pull/1';
  const state = {
    work: {
      'W-1': { id: 'W-1', phase: 'awaiting_human_approval', links: { pr: PR }, updatedAt: now, updates: [] },
      'W-2': { id: 'W-2', phase: 'implementation', updatedAt: old, updates: [], assignments: [{ id: 'R1', status: 'blocked', version: 3, waitingOn: 'TB-9', at: old }] },
      'W-3': { id: 'W-3', kind: 'factory', phase: 'intake', updatedAt: old, updates: [{ at: old, text: 'Fixed in 3fd21f7, suite green' }] },
      'W-4': { id: 'W-4', phase: 'implementation', updatedAt: old, updates: [{ at: old, text: 'started' }], assignments: [{ id: 'R2', status: 'started', at: old }] },
      'W-5': { id: 'W-5', phase: 'implementation', updatedAt: now, updates: [{ at: now, text: 'checkpoint' }], assignments: [{ id: 'R1', status: 'started', at: old }] },
      'W-6': { id: 'W-6', phase: 'done', links: { pr: PR }, updatedAt: old, updates: [] },
    },
    questions: { 'TB-9': { status: 'answered' } },
    messages: { 'M-1': { about: { resume: 'W-2/R1/v3' }, at: old } },
  };
  const got = contradictions(state, { prState: u => (u === PR ? 'MERGED' : null), now });
  assert.deepEqual(got.map(c => `${c.kind}/${c.id}`).sort(), ['answered-still-blocked/W-2', 'factory-fix-open/W-3', 'merged-awaiting/W-1', 'started-silent/W-4']);
  for (const c of got) assert.ok(c.evidence && c.next, `${c.kind} carries evidence and a next action`);
  assert.deepEqual(contradictions(state, { now }).map(c => c.kind).includes('merged-awaiting'), false, 'no fresh PR read: no merge claim');
});

test('the contradiction audit names a record once per kind, and leaves held factory records alone (review of 8fb142f)', () => {
  const now = '2026-11-10T12:00:00.000Z', old = '2026-11-09T00:00:00.000Z';
  const state = { questions: {}, messages: {}, work: {
    'W-1': { id: 'W-1', phase: 'implementation', updatedAt: old, updates: [], assignments: [{ id: 'R1', status: 'started', at: old }, { id: 'R2', kind: 'review', status: 'started', at: old }] },
    'W-2': { id: 'W-2', kind: 'factory', phase: 'intake', updatedAt: old, externalDeps: [{ ref: 'deferred product', deferred: 'product', text: 'deferred to product' }], updates: [{ at: old, text: 'seen at 8fb142f' }] },
  } };
  assert.deepEqual(contradictions(state, { now }).map(c => `${c.kind}/${c.id}`), ['started-silent/W-1']);
});

test('the audit names a closed record that still has a live job (W-383)', () => {
  const state = { questions: {}, messages: {}, work: { 'W-128': { id: 'W-128', phase: 'done', updatedAt: '2026-11-02T00:00:00.000Z', updates: [], assignments: [{ id: 'R1', status: 'started', at: '2026-10-30T00:00:00.000Z' }] } } };
  assert.deepEqual(contradictions(state, { now: '2026-11-10T23:00:00.000Z' }).map(c => `${c.kind}/${c.id}`), ['closed-with-live-job/W-128']);
});

test("the board developer can mark two records as the same work, so a follow-up filed beside a PR's record closes when that PR merges (W-418: W-415 beside W-234 on teamwork-mini #1)", async () => {
  const { openStore } = await import('../core/store.mjs');
  const { commandsFor } = await import('../core/actions.mjs');
  const { sourceIndex } = await import('../core/correlate.mjs');
  const s = openStore(':memory:'), c = { now: '2026-11-11T22:00:00.000Z', by: 'triage board worker' };
  const PR1 = 'https://github.com/alexbatesdev/teamwork-mini-mcp/pull/1';
  const owner = s.append({ kind: 'create', payload: { title: 'add create_task', source: { type: 'agent', by: 'local-head' }, links: { pr: PR1 } } }, c).id;
  const follow = s.append({ kind: 'create', payload: { title: 'drop the tool' } }, c).id;
  s.appendAll(commandsFor('relate', { work: follow, to: owner, note: 'its work is on #1' }), c);
  const bySource = Object.fromEntries(sourceIndex(s.state));
  const ids = mergeCloses(s.state.work, bySource, { prState: u => u === PR1 ? 'MERGED' : null, openQuestions: () => 0, track: () => 'stream' }).map(x => x.id).sort();
  assert.deepEqual(ids, [owner, follow].sort());
  assert.throws(() => commandsFor('relate', { work: follow }), /to/);
});

test('a record parked with waitingOn a PR is released when it merges and reported when it closes (W-436: W-422 sat on merged #8722)', () => {
  const works = { 'W-422': { id: 'W-422', phase: 'ready', repo: 'app', links: {}, externalDeps: [], assignments: [], waitingOn: { who: '#8722', what: 'close no-change once it merges', by: 'sup: stream-2' } },
    'W-9': { id: 'W-9', phase: 'ready', links: {}, externalDeps: [], assignments: [], waitingOn: { who: 'QA owner', what: 'x', by: 'sup: s1' } } };
  const url = 'https://github.com/acme-org/app/pull/8722';
  const r = holdReleases(works, 'acme-org', u => u === url ? 'MERGED' : null);
  assert.ok(r.urls.includes(url), 'the PR is read');
  assert.deepEqual(r.waitsMerged, [{ id: 'W-422', pr: '#8722', to: 'sup: stream-2' }]);
  assert.deepEqual(holdReleases(works, 'acme-org', u => u === url ? 'CLOSED' : null).waitsClosed, [{ id: 'W-422', pr: '#8722', to: 'sup: stream-2' }]);
});
