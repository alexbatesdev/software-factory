// The deliverable inbox (Alex 11-18): reports and information a task produces that don't belong in a git repo.
// Agents and Alex read it; either archives an item once it no longer matters. Neutral fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { commandsFor } from '../core/actions.mjs';
import { refusal } from '../core/capabilities.mjs';

const c = (by, now = '2026-11-18T22:00:00.000Z') => ({ now, by });
function store() {
  const s = openStore(':memory:', { supervisors: ['sup: s1'] });
  s.append({ kind: 'create', payload: { title: 'Investigate the import gap' } }, c('local-head'));
  return s;
}

test('a deliverable is kept with its record, author and time, and stays active until archived', () => {
  const s = store();
  for (const cmd of commandsFor('deliver', { work: 'W-1', title: 'Import gap findings', text: '# Findings\n- one' })) s.append(cmd, c('sup: s1'));
  assert.deepEqual(Object.values(s.state.deliverables).map(({ id, work, title, from, archived }) => ({ id, work, title, from, archived })),
    [{ id: 'D-1', work: 'W-1', title: 'Import gap findings', from: 'sup: s1', archived: null }]);
  assert.equal(s.state.deliverables['D-1'].text, '# Findings\n- one');
  assert.equal(s.state.work['W-1'].phase, s.state.work['W-1'].phase, 'delivering does not close the record');
  for (const cmd of commandsFor('archive_deliverable', { id: 'D-1', note: 'acted on' })) s.append(cmd, c('Alex (dashboard)'));
  assert.deepEqual(s.state.deliverables['D-1'].archived, { by: 'Alex (dashboard)', at: '2026-11-18T22:00:00.000Z', note: 'acted on' });
  for (const cmd of commandsFor('archive_deliverable', { id: 'D-1', unarchive: true })) s.append(cmd, c('local-head'));
  assert.equal(s.state.deliverables['D-1'].archived, null, 'and can come back');
});

test('a deliverable needs a record that exists, a title and its text, within a size limit', () => {
  const s = store(), bad = args => assert.throws(() => commandsFor('deliver', args).forEach(cmd => s.append(cmd, c('sup: s1'))));
  bad({ work: 'W-9', title: 't', text: 'x' });
  bad({ work: 'W-1', text: 'x' });
  bad({ work: 'W-1', title: 't' });
  bad({ work: 'W-1', title: 't', text: 'x'.repeat(200001) });
  assert.throws(() => s.append({ kind: 'deliverable_archive', target: 'D-7', payload: {} }, c('local-head')), /no deliverable D-7/);
});

test('workers deliver; the seats that manage work also archive; nobody else does either', () => {
  assert.equal(refusal('sbx-worker', 'deliver', { work: 'W-1' }, {}), null);
  assert.ok(refusal('sbx-worker', 'archive_deliverable', { id: 'D-1' }, {}));
  for (const role of ['local-head', 'stream-supervisor', 'factory-lead']) for (const a of ['deliver', 'archive_deliverable']) assert.equal(refusal(role, a, { work: 'W-1', id: 'D-1' }, {}), null, `${role} ${a}`);
  assert.ok(refusal('questions-router', 'deliver', { work: 'W-1' }, {}));
});

test('local-head hears of each new deliverable once, so it can bring it to Alex', async () => {
  const { inboxCommands } = await import('../core/inbox.mjs');
  const s = store();
  for (const cmd of commandsFor('deliver', { work: 'W-1', title: 'Import gap findings', text: 'x' })) s.append(cmd, c('sup: s1'));
  const told = () => inboxCommands(s.state, { supervisors: ['sup: s1'], seats: [] }, null).cmds.filter(m => m.payload.about?.deliverable);
  const [m] = told();
  assert.deepEqual([m.payload.to, m.payload.work, m.payload.about], ['local-head', 'W-1', { deliverable: 'D-1' }]);
  assert.match(m.payload.text, /D-1 "Import gap findings" from sup: s1/);
  s.append(m, c('factory'));
  assert.deepEqual(told(), []);
});

