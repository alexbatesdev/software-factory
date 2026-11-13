import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { openStore, skippedIds } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';

// Alex, 11-12: one toggle pauses the factory on every support task, so he can work them with his own agent.
const T = '2026-11-12T21:00:00.000Z', config = { roles: {}, routing: { supervisors: {} }, autoDispatch: { exclude: ['W-3'] } };

async function serve() {
  const store = openStore(':memory:', { supervisors: [] });
  store.append({ kind: 'create', payload: { title: 'Globex ADP' } }, { now: T, by: 'test' });
  store.state.work['W-1'].support = true;
  store.append({ kind: 'create', payload: { title: 'Ordinary work' } }, { now: T, by: 'test' });
  store.append({ kind: 'create', payload: { title: 'Listed by hand' } }, { now: T, by: 'test' });
  const server = http.createServer(createApi({ store, config, now: () => T }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pause = async paused => (await fetch(`${base}/api/support-pause`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory': '1' }, body: JSON.stringify({ paused }) })).status;
  return { store, pause, board: async () => (await fetch(`${base}/api/board`)).json(), close: () => server.close() };
}

test('pausing support skips every support record, alongside the exclude list, until Alex resumes it', async () => {
  const f = await serve();
  try {
    assert.deepEqual(skippedIds(f.store.state, config), ['W-3']);
    assert.equal(await f.pause(true), 200);
    assert.deepEqual(skippedIds(f.store.state, config).sort(), ['W-1', 'W-3']);
    assert.deepEqual([(await f.board()).supportPause.by, (await f.board()).supportPause.at], ['Alex (dashboard)', T]);
    assert.equal(await f.pause(false), 200);
    assert.deepEqual(skippedIds(f.store.state, config), ['W-3']);
    assert.equal((await f.board()).supportPause, null);
  } finally { f.close(); }
});

test('the live loop decides what the factory skips in one place, and the page has the toggle', () => {
  const live = readFileSync(new URL('../bin/live.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(live, /trackOf\(w, config\)/, 'pass { exclude: skippedIds(...) }, never the raw config');
  assert.doesNotMatch(live, /autoDispatch\??\.exclude/, 'the exclude list is read only by skippedIds');
  assert.match(readFileSync(new URL('../views/index.html', import.meta.url), 'utf8'), /\/api\/support-pause/);
});

test('a support task that arrives while support is paused waits in intake without pinging the board lead', async () => {
  const { inboxCommands } = await import('../core/inbox.mjs');
  const w = { id: 'W-9', title: 'New support', phase: 'intake', createdAt: T, requests: [], assignments: [], updates: [] };
  const state = { work: { 'W-9': w }, questions: {}, messages: {}, notifications: {} };
  const intake = exclude => inboxCommands(state, { supervisors: [], seats: [], exclude, triage: { seat: 'board lead', since: '2026-11-01' } }, null).cmds.filter(c => c.payload.about?.intake).length;
  assert.equal(intake([]), 1);
  assert.equal(intake(['W-9']), 0);
});
