import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prKey, isPrUnit, unitsOf, groupIndex } from '../core/units.mjs';

const PR = n => `https://github.com/builtforteams/built-rails/pull/${n}`;
const works = {
  'W-86': { id: 'W-86', kind: 'pr-feedback', source: { type: 'pr', key: 'built-rails-8244' }, links: { pr: PR(8244) } },
  'W-75': { id: 'W-75', kind: 'build', source: { type: 'agent' }, links: { pr: PR(8355) } },
  'W-60': { id: 'W-60', kind: 'build', source: { type: 'teamwork', key: 'tw-1' }, links: { pr: PR(8244) } },
  'W-85': { id: 'W-85', kind: 'build', source: { type: 'teamwork', key: 'tw-2' }, links: {}, related: [{ to: 'W-86', kind: 'same-work' }] },
  'W-44': { id: 'W-44', kind: 'build', source: { type: 'teamwork', key: 'tw-3' }, links: { pr: PR(8244) }, coverage: { state: 'open-pr', prs: [{ url: PR(8355) }] } },
  'W-41': { id: 'W-41', kind: 'build', source: { type: 'teamwork', key: 'tw-4' }, links: { pr: PR(8239) } },
  'W-9': { id: 'W-9', kind: 'build', source: { type: 'teamwork', key: 'tw-5' }, links: {} },
  'W-120': { id: 'W-120', kind: 'build', source: { type: 'agent' }, links: {}, parent: 'W-86' },
};
const bySource = { 'built-rails-8244': 'W-86', 'built-rails-8355': 'W-75', 'built-rails-8239': 'W-41' };

test('a PR unit is the PR-shaped record holding the PR; a task holding a PR key is not one', () => {
  assert.equal(prKey(PR(8244)), 'built-rails-8244');
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
  const run = state => mergeCloses(ws, { 'tw-1': 'W-149', 'built-rails-8487': 'W-149' }, { prState: u => state, openQuestions: () => 0, track: () => 'stream' });
  assert.deepEqual(run('MERGED').map(c => [c.id, c.prs]), [['W-149', [PR(8487)]]]);
  assert.deepEqual(run('OPEN'), []);
});

import { holdReleases } from '../core/units.mjs';
test('a merge hold is released when its PR merges, and only then', () => {
  const ws = { 'W-1': { id: 'W-1', phase: 'intake', repo: null, externalDeps: [{ pr: '#8606' }, { text: 'a person' }] }, 'W-2': { id: 'W-2', phase: 'done', externalDeps: [{ pr: '#8606' }] } };
  const url = 'https://github.com/builtforteams/built-rails/pull/8606';
  assert.deepEqual(holdReleases(ws, 'builtforteams').urls, [url]);
  assert.deepEqual(holdReleases(ws, 'builtforteams', u => (u === url ? 'MERGED' : null)).released, [{ id: 'W-1', pr: '#8606' }]);
  assert.deepEqual(holdReleases(ws, 'builtforteams', () => 'OPEN').released, []);
  assert.deepEqual(holdReleases(ws, 'builtforteams', () => 'CLOSED').released, []);
  assert.deepEqual(holdReleases(ws, 'builtforteams', () => 'CLOSED').closed, [{ id: 'W-1', pr: '#8606' }], 'a PR closed unmerged is reported, never released');
});
