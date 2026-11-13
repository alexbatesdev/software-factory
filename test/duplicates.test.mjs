import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { pathsOf, duplicateCommands } from '../core/duplicates.mjs';
import { autoDispatchPlan } from '../core/dispatch.mjs';
import { prGateView } from '../core/store.mjs';

// W-471: the duplicate search ran once at triage (00:41Z); sam-built's #8814 opened at 16:06Z on the same file and
// W-463 was approved and dispatched at 16:19Z with no re-check.
const S1 = 'sup: stream-1', T0 = '2026-11-13T00:41:00.000Z', T1 = '2026-11-13T16:10:00.000Z';
const OBJ = 'brakeman warning at app/queries/headcount_planning/expanded_datasheet_sources.rb:87; fix with an entry in config/brakeman.ignore.';
const SAM = { url: 'https://github.com/builtforteams/built-rails/pull/8814', author: 'sam-built', createdAt: '2026-11-13T16:06:48Z', files: ['config/brakeman.ignore', 'spec/support/example_watchdog.rb'] };
const OLD = { url: 'https://github.com/builtforteams/built-rails/pull/8700', author: 'dependabot', createdAt: '2026-11-10T00:00:00Z', files: ['Gemfile.lock'] };
const MINE = { url: 'https://github.com/builtforteams/built-rails/pull/8815', author: 'alexbatesdev', createdAt: '2026-11-13T16:27:50Z', files: ['config/brakeman.ignore'] };

function proposed({ approved = false } = {}) {
  const store = openStore(':memory:', { supervisors: [S1] });
  const ctx = { now: T0, by: 'board lead' };
  store.append({ kind: 'create', payload: { title: 'Brakeman on main', kind: 'pr-feedback', repo: 'built-rails', objective: OBJ, source: { type: 'agent', by: 'local-head' }, stream: S1 } }, ctx);
  store.append({ kind: 'event', target: 'W-1', payload: { type: 'transition', to: 'ready' } }, ctx);
  store.append({ kind: 'event', target: 'W-1', payload: { type: 'proposal', prompted: 'p', addresses: 'a', whyThisFix: 'w', since: 's', customerImpact: 'none', duplicateSearch: 'none touching config/brakeman.ignore' } }, ctx);
  if (approved) store.append({ kind: 'event', target: 'W-1', payload: { type: 'pr_approved' } }, { now: T1, by: 'local-head' });
  return store;
}
const check = (store, prs, now = '2026-11-13T16:19:00.000Z') => { for (const c of duplicateCommands(store.state, { 'built-rails': prs }, { me: 'alexbatesdev' })) store.append(c, { now, by: 'board (duplicate check)' }); };

test("a New-PR record's files come from its objective and breakdown", () => {
  assert.deepEqual(pathsOf(proposed().state.work['W-1']).sort(), ['app/queries/headcount_planning/expanded_datasheet_sources.rb', 'config/brakeman.ignore']);
});

test('another author opening a PR on the same file after the search takes back the approval: no dispatch, and the match is on the card', () => {
  const store = proposed({ approved: true });
  check(store, [SAM, OLD, MINE]);
  const w = store.state.work['W-1'];
  assert.equal(w.prApproval, null, 'back to Alex');
  assert.deepEqual(w.duplicateHits.matches.map(m => [m.pr, m.author, m.files]), [[SAM.url, 'sam-built', ['config/brakeman.ignore']]]);
  assert.match(w.updates.at(-1).text, /#8814 by sam-built.*config\/brakeman\.ignore/);
  const view = prGateView(store.state, w);
  const plan = autoDispatchPlan([view], { supervisors: { [S1]: {} } }, {});
  assert.ok(!plan.some(p => p.id === 'W-1' && p.action === 'dispatch'), JSON.stringify(plan));
});

test('the same match is said once; Alex approving again builds it anyway; a newer match holds it again', () => {
  const store = proposed({ approved: true });
  check(store, [SAM]);
  const n = store.state.work['W-1'].updates.length;
  check(store, [SAM]);
  assert.equal(store.state.work['W-1'].updates.length, n, 'no repeat');
  store.append({ kind: 'event', target: 'W-1', payload: { type: 'pr_approved' } }, { now: '2026-11-13T16:30:00.000Z', by: 'Alex (dashboard)' });
  check(store, [SAM], '2026-11-13T16:35:00.000Z');
  assert.ok(store.state.work['W-1'].prApproval, 'seen matches stay dismissed');
  check(store, [SAM, { ...SAM, url: SAM.url.replace('8814', '8820'), createdAt: '2026-11-13T16:32:00Z' }], '2026-11-13T16:40:00.000Z');
  assert.equal(store.state.work['W-1'].prApproval, null);
});

test('a record that already has its PR, or no proposal, is not checked', () => {
  const store = proposed();
  store.state.work['W-1'].links = { pr: MINE.url };
  assert.deepEqual(duplicateCommands(store.state, { 'built-rails': [SAM] }, { me: 'alexbatesdev' }), []);
});

test('an approved New-PR record waits for a re-check newer than the approval, and a clean one lets it dispatch', () => {
  const store = proposed({ approved: true });
  const plan = () => autoDispatchPlan([prGateView(store.state, store.state.work['W-1'])], { supervisors: { [S1]: {} } }, {});
  assert.match(JSON.stringify(plan()), /re-checking open PRs/);
  check(store, [OLD]);
  assert.match(store.state.work['W-1'].updates.at(-1).text, /no open PR by another author touches/);
  assert.ok(plan().some(p => p.id === 'W-1' && p.action), JSON.stringify(plan()));
});

test('the New PRs card shows the match next to Approve', async () => {
  const { readFileSync } = await import('node:fs');
  assert.match(readFileSync(new URL('../views/index.html', import.meta.url), 'utf8'), /p\.duplicateHits/);
});

test('a record with no repo is checked against built-rails, where New-PR records land', () => {
  const store = proposed();
  store.state.work['W-1'].repo = null;
  assert.equal(duplicateCommands(store.state, { 'built-rails': [SAM] }, { me: 'alexbatesdev' }).length, 1);
});
