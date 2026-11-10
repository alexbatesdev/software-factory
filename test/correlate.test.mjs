import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { sourceCommands, sourceIndex } from '../core/correlate.mjs';
import { parseAcs } from '../core/derive.mjs';

const ctx = (by = 'test') => ({ now: '2026-10-30T18:00:00.000Z', by });
const PR = n => `https://github.com/builtforteams/built-rails/pull/${n}`;
const task = (tw, title) => ({ id: `tw-${tw}`, kind: 'task', ref: String(tw), title, url: `https://x.teamwork.com/app/tasks/${tw}`, description: '' });
const pr = (n, branch) => ({ id: `built-rails-${n}`, kind: 'pr', repo: 'built-rails', ref: `built-rails#${n}`, title: `PR ${n}`, url: PR(n), branch, noFeedback: true });
const poll = (s, items, type) => sourceCommands(s.state, new Map(items.map(i => [i.id, i])), type, parseAcs).map(c => s.append(c, ctx('poller')));
const open = () => openStore(':memory:', { supervisors: ['sup: stream-2'] });

test("a task's own PR joins its record by branch instead of becoming a record (W-115/#8462, W-32/#8421)", () => {
  const s = open();
  poll(s, [task(41454539, 'Ask Built asset'), task(41073672, 'Ashby req details')], 'teamwork');
  const [w115, w32] = Object.keys(s.state.work);
  s.append({ kind: 'update', target: w32, payload: { links: { pr: PR(8421) } } }, ctx());
  poll(s, [pr(8462, 'alex/confidential/ask-built-asset-confidential/41454539'), pr(8421, 'alex/ashby-req-details-sent-data/41073672')], 'pr');
  assert.equal(Object.keys(s.state.work).length, 2, 'no PR records');
  assert.equal(s.state.work[w115].links.pr, PR(8462));
  assert.ok(s.state.work[w115].aliases.includes('built-rails-8462'));
  assert.ok(s.state.work[w32].aliases.includes('built-rails-8421'));
  assert.deepEqual(poll(s, [pr(8462, 'alex/confidential/ask-built-asset-confidential/41454539')], 'pr'), [], 'a repeat poll is not news');
});

test("a worker's PR the poller filed first is absorbed when the record that produced it claims it (W-60/#8456)", () => {
  const s = open();
  poll(s, [task(41384318, 'Position end date')], 'teamwork');
  const [w60] = Object.keys(s.state.work);
  poll(s, [pr(8456, 'alex/position-end-date/5a-apply-engine')], 'pr');
  const placeholder = Object.keys(s.state.work).find(id => id !== w60);
  s.append({ kind: 'update', target: w60, payload: { links: { pr: PR(8456) } } }, ctx('sup: stream-2'));
  assert.equal(s.state.work[placeholder].phase, 'cancelled');
  assert.equal(s.state.work[placeholder].completion.absorbedInto, w60);
  assert.equal(s.state.work[w60].links.pr, PR(8456));
  assert.deepEqual(s.replay(), s.state);
});

test('a PR another live, owned record carries is never taken', () => {
  const s = open();
  poll(s, [task(1111111, 'A'), task(2222222, 'B')], 'teamwork');
  const [a, b] = Object.keys(s.state.work);
  s.append({ kind: 'update', target: a, payload: { owner: 'sup: stream-2', links: { pr: PR(9000) } } }, ctx());
  assert.equal(s.state.work[a].stream, 'sup: stream-2', 'owner and stream stay paired');
  poll(s, [pr(9000, 'no-task-in-branch')], 'pr');
  assert.equal(Object.keys(s.state.work).length, 2, 'a PR a record links is that record');
  assert.throws(() => s.append({ kind: 'update', target: b, payload: { links: { pr: PR(9000) } } }, ctx()), /already belongs to/);
});

test('a source item that leaves the read marks its record gone, once', () => {
  const s = open();
  poll(s, [task(3333333, 'C')], 'teamwork');
  poll(s, [], 'teamwork');
  assert.equal(Object.values(s.state.work)[0].upstream, 'gone');
  assert.deepEqual(poll(s, [], 'teamwork'), []);
});

test("a PR's own record wins over an older task record that links it (W-60 and W-86 on #8244)", () => {
  const s = open();
  poll(s, [task(41384318, 'Position end date')], 'teamwork');
  const [w60] = Object.keys(s.state.work);
  poll(s, [pr(8244, 'no-task-in-branch')], 'pr');
  const w86 = Object.keys(s.state.work).find(id => id !== w60);
  s.append({ kind: 'event', target: w60, payload: { type: 'relate', to: w86 } }, ctx());
  s.append({ kind: 'update', target: w60, payload: { links: { pr: PR(8244) } } }, ctx());
  assert.deepEqual(poll(s, [pr(8244, 'no-task-in-branch')], 'pr'), []);
});

test('a mutation-tester PR becomes a record like any other (Alex, 11-09)', () => {
  const s = open();
  const cmds = sourceCommands(s.state, new Map([['built-rails-8283', pr(8283, 'alex/mutation-tester')]]), 'pr', parseAcs, {});
  assert.equal(cmds.length, 1);
});

test("after an absorb, the PR belongs to the record that claimed it, not the placeholder", () => {
  const s = open();
  poll(s, [task(41384318, 'Position end date')], 'teamwork');
  const [w60] = Object.keys(s.state.work);
  poll(s, [pr(8456, 'alex/position-end-date/5a-apply-engine')], 'pr');
  s.append({ kind: 'update', target: w60, payload: { links: { pr: PR(8456) } } }, ctx('sup: stream-2'));
  const placeholder = Object.keys(s.state.work).find(id => id !== w60), before = structuredClone(s.state.work[placeholder]);
  assert.equal(sourceIndex(s.state).get('built-rails-8456'), w60);
  poll(s, [{ ...pr(8456, 'alex/position-end-date/5a-apply-engine'), title: 'Renamed PR' }], 'pr');
  assert.deepEqual(s.state.work[placeholder], before, 'the cancelled placeholder is never refreshed again');
});

test('a second PR naming a task that already has a PR gets its own record, never joins the task', () => {
  const s = open();
  poll(s, [task(41454542, 'Edit modal custom fields')], 'teamwork');
  const [w] = Object.keys(s.state.work);
  s.append({ kind: 'update', target: w, payload: { links: { pr: PR(8469) } } }, ctx());
  poll(s, [pr(8480, 'alex/confidential/edit-modal-part-2/41454542')], 'pr');
  assert.equal(s.state.work[w].links.pr, PR(8469));
  assert.equal(Object.keys(s.state.work).length, 2, 'the second PR is its own record');
});

test('a worker PR joins the one live record whose notes name its branch, even before the branch is linked (W-180: #8535 into W-124)', () => {
  const at = now => ({ now, by: 'poller' });
  const run = now => {
    const s = open();
    const id = s.append({ kind: 'create', payload: { title: 'Ask Built assign_assets', kind: 'build', criteria: ['checked'] } }, at(now)).id;
    s.append({ kind: 'event', target: id, payload: { type: 'assign', assignmentId: 'R1', kind: 'implementation', status: 'started', owner: 'sup: stream-2', evidence: 'brief' } }, at(now));
    s.append({ kind: 'event', target: id, payload: { type: 'note', text: 'Worker on branch alex/ask-built/assign-assets-check, PR to follow.' } }, at(now));
    for (const c of sourceCommands(s.state, new Map([[`built-rails-8535`, pr(8535, 'alex/ask-built/assign-assets-check')]]), 'pr', parseAcs)) s.append(c, at(now));
    return { s, id };
  };
  const { s, id } = run('2026-11-06T00:00:00.000Z');
  assert.deepEqual(Object.keys(s.state.work), [id], 'no duplicate record');
  assert.equal(s.state.work[id].links.pr, PR(8535));
  assert.equal(Object.keys(run('2026-11-04T18:48:00.000Z').s.state.work).length, 2, 'rows from before the rule replay as they were decided');
});

test('a worker PR joins the live record its supervisor named the branch on (W-180 repeat: #8570 into W-137)', async () => {
  const { commandsFor } = await import('../core/actions.mjs');
  const at = { now: '2026-11-06T00:00:00.000Z', by: 'sup: stream-1' };
  const s = open();
  const id = s.append({ kind: 'create', payload: { title: 'Granted employees read custom fields', kind: 'build', criteria: ['readable'] } }, at).id;
  s.appendAll(commandsFor('assign', { work: id, assignmentId: 'R1', kind: 'implementation', status: 'started', owner: 'sbx: stream-1', evidence: 'brief file', branch: 'alex/confidential/granted-employee-custom-fields' }), at);
  for (const c of sourceCommands(s.state, new Map([['built-rails-8570', pr(8570, 'alex/confidential/granted-employee-custom-fields')]]), 'pr', parseAcs)) s.append(c, { ...at, by: 'poller' });
  assert.deepEqual(Object.keys(s.state.work), [id], 'no duplicate record');
  assert.equal(s.state.work[id].links.pr, PR(8570));
});

test("a Teamwork record's objective is the task's description, so triage can read the task; one a seat wrote is kept (W-303)", () => {
  const s = open(), at = { now: '2026-11-10T00:00:00.000Z', by: 'poller' }, cfg = { now: at.now };
  const t = { ...task(41517664, 'Carrix | INVESTIGATE'), description: 'Termination did not remove the future position.' };
  const run = items => sourceCommands(s.state, new Map(items.map(i => [i.id, i])), 'teamwork', parseAcs, cfg).map(c => s.append(c, at));
  run([t]);
  const [id] = Object.keys(s.state.work);
  assert.equal(s.state.work[id].objective, 'Termination did not remove the future position.');
  assert.deepEqual(run([t]), [], 'no change, no command');
  s.append({ kind: 'update', target: id, payload: { objective: 'Scoped by board lead' } }, at);
  run([{ ...t, description: 'Edited in Teamwork' }]);
  assert.equal(s.state.work[id].objective, 'Scoped by board lead');
  const old = open();
  sourceCommands(old.state, new Map([[t.id, t]]), 'teamwork', parseAcs, { now: '2026-11-09T00:00:00.000Z' }).map(c => old.append(c, ctx('poller')));
  assert.equal(Object.values(old.state.work)[0].objective || '', '', 'rows logged before the change replay as before');
});

test("a hand-made record that links a Teamwork task is that task's record: the poller joins it instead of filing a duplicate (W-352/W-354)", () => {
  const s = open(), at = now => ({ now, by: 'test' });
  const id = s.append({ kind: 'create', payload: { title: 'OSUP | INVESTIGATE', links: { source: 'https://builtforteams.teamwork.com/app/tasks/41503361' } } }, at('2026-11-10T20:00:00.000Z')).id;
  const seen = s.append({ kind: 'observe_source', payload: { ...task(41503361, 'OSUP | INVESTIGATE | User Unable To Submit Req'), support: true } }, at('2026-11-10T20:01:00.000Z')).id;
  assert.equal(seen, id, 'joined, not a second record');
  assert.ok(s.state.work[id].aliases.includes('tw-41503361'));
  assert.equal(s.state.work[id].support, true, 'a support task makes its joined record support work');
  assert.equal(Object.keys(s.state.work).length, 1);
  const old = open();
  old.append({ kind: 'create', payload: { title: 'x', links: { source: 'https://builtforteams.teamwork.com/app/tasks/7' } } }, at('2026-11-10T18:00:00.000Z'));
  old.append({ kind: 'observe_source', payload: task(7, 'x') }, at('2026-11-10T18:01:00.000Z'));
  assert.equal(Object.keys(old.state.work).length, 2, 'replay before the change keeps its two records');
});
