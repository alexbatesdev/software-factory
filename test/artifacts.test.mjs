import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../core/store.mjs';
import { parseLink, retainArtifacts, ARTIFACTS_FROM } from '../core/artifacts.mjs';
import { backup, verifyBackup } from '../bin/backup.mjs';

// Evolution phase 1 step 2: review evidence outlives the worker and its sandbox.
const SUP = 'sup: stream-1', T = '2026-11-13T12:00:00.000Z', HEAD = 'a'.repeat(40);
const sha = s => createHash('sha256').update(s).digest('hex');

function reviewed(link, at = T) {
  const store = openStore(':memory:', { supervisors: [SUP] });
  const by = { now: at, by: SUP };
  store.append({ kind: 'create', payload: { title: 'x', stream: SUP } }, by);
  const w = store.state.work['W-1'];
  w.phase = 'review'; w.head = HEAD; w.stream = SUP;
  w.reviews.push({ head: HEAD, by: 'sbx: stream-1 internal-review', result: 'clean', at, link });
  return store;
}

test('a review link is a host path, a path in the worker sandbox, or prose with no file', () => {
  assert.deepEqual(parseLink('/Users/dev/Code/plans/w80-r9-report.md'), { from: 'host', path: '/Users/dev/Code/plans/w80-r9-report.md' });
  assert.deepEqual(parseLink('tmp/internal-review-8774-f85671ef61a6.md (in the sbx VM clone)'), { from: 'sandbox', path: 'tmp/internal-review-8774-f85671ef61a6.md' });
  assert.deepEqual(parseLink('W-367 worker note 02:39Z (two fresh rounds)'), { from: 'none' });
});

test('a host report is copied by its hash, once, and a second pass copies nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spamton-art-'));
  const store = reviewed('/Users/dev/Code/plans/w80-r9-report.md');
  const io = { readHost: async () => Buffer.from('# Review\nclean'), now: () => T, root };
  await retainArtifacts(store, io);
  const [a] = Object.values(store.state.artifacts);
  assert.deepEqual([a.work, a.status, a.sha256, a.head], ['W-1', 'retained', sha('# Review\nclean'), HEAD]);
  assert.equal(readFileSync(join(root, a.sha256.slice(0, 2), a.sha256), 'utf8'), '# Review\nclean');
  await retainArtifacts(store, io);
  assert.equal(Object.keys(store.state.artifacts).length, 1);
});

test("a sandbox report is read from the record's stream worker before it is recycled", async () => {
  const root = mkdtempSync(join(tmpdir(), 'spamton-art-'));
  const store = reviewed('tmp/internal-review-8774-f85671ef61a6.md (in the sbx VM clone)');
  const asked = [];
  await retainArtifacts(store, { readSandbox: async (stream, path) => { asked.push([stream, path]); return { bytes: Buffer.from('ok'), found: '/w/tmp/x.md' }; }, now: () => T, root });
  assert.deepEqual(asked, [[SUP, 'tmp/internal-review-8774-f85671ef61a6.md']]);
  assert.equal(Object.values(store.state.artifacts)[0].status, 'retained');
});

test('prose records no file; a secret-looking report is withheld; a failed read retries and then stops', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spamton-art-'));
  const prose = reviewed('two fresh rounds, zero findings');
  await retainArtifacts(prose, { now: () => T, root });
  assert.equal(Object.values(prose.state.artifacts)[0].status, 'no_file');

  const secret = reviewed('/Users/dev/Code/plans/leak.md');
  await retainArtifacts(secret, { readHost: async () => Buffer.from('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), now: () => T, root });
  const s = Object.values(secret.state.artifacts)[0];
  assert.equal(s.status, 'withheld');
  assert.equal(s.sha256, null, 'nothing secret is stored');

  const gone = reviewed('/Users/dev/Code/plans/missing.md');
  const io = { readHost: async () => { throw new Error('ENOENT'); }, now: () => T, root };
  for (let i = 0; i < 6; i++) await retainArtifacts(gone, io);
  const g = Object.values(gone.state.artifacts)[0];
  assert.deepEqual([g.status, g.attempts], ['failed', 3]);
  assert.match(g.detail, /ENOENT/);
});

test('reviews from before the store existed are left alone (no historical backfill)', async () => {
  const store = reviewed('/Users/dev/Code/plans/old.md', '2026-11-01T00:00:00.000Z');
  assert.ok('2026-11-01T00:00:00.000Z' < ARTIFACTS_FROM);
  await retainArtifacts(store, { readHost: async () => assert.fail('no backfill'), now: () => T, root: tmpdir() });
  assert.deepEqual(store.state.artifacts || {}, {});
});

test('a backup restores to an isolated folder: the db replays and every retained file matches its hash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'spamton-bk-'));
  const root = join(dir, 'artifacts'), db = join(dir, 'factory.db');
  const live = openStore(db, { supervisors: [SUP] });
  live.append({ kind: 'artifact', payload: { work: 'W-1', head: HEAD, link: 'x', key: 'k', status: 'retained', sha256: sha('hi'), bytes: 2 } }, { now: T, by: 'board (artifacts)' });
  writeFileSync(join(dir, 'spamton-hi'), 'hi');
  const { mkdirSync, copyFileSync } = await import('node:fs');
  mkdirSync(join(root, sha('hi').slice(0, 2)), { recursive: true }); copyFileSync(join(dir, 'spamton-hi'), join(root, sha('hi').slice(0, 2), sha('hi')));
  const to = join(dir, 'backup');
  backup({ db, root, to });
  assert.ok(existsSync(join(to, 'factory.db')));
  assert.deepEqual(verifyBackup(to), { events: 1, artifacts: 1, problems: [] });
  writeFileSync(join(to, 'artifacts', sha('hi').slice(0, 2), sha('hi')), 'tampered');
  assert.equal(verifyBackup(to).problems.length, 1);
});

test('a cold reader gets the retained report from the factory by its hash, and the record lists its artifacts', async () => {
  const http = await import('node:http');
  const { createApi } = await import('../core/api.mjs');
  const root = mkdtempSync(join(tmpdir(), 'spamton-art-'));
  const store = reviewed('/Users/dev/Code/plans/w80-r9-report.md');
  await retainArtifacts(store, { readHost: async () => Buffer.from('# kept'), now: () => T, root });
  const server = http.createServer(createApi({ store, config: { routing: { supervisors: { [SUP]: {} } } }, artifactRoot: root }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const s = await (await fetch(`${base}/api/state`)).json();
    const [a] = Object.values(s.artifacts);
    assert.equal(a.work, 'W-1');
    const r = await fetch(`${base}/api/artifacts/${a.sha256}`);
    assert.deepEqual([r.status, await r.text()], [200, '# kept']);
    assert.equal((await fetch(`${base}/api/artifacts/..%2Fetc`)).status, 404);
  } finally { server.close(); }
});

test('backups come from config: off when disabled, otherwise its folder, interval and days kept (Alex, 11-13)', async () => {
  const { backupPlan } = await import('../bin/backup.mjs');
  assert.equal(backupPlan({ backup: { enabled: false, root: '/x' } }, '/h'), null);
  assert.deepEqual(backupPlan({}, '/h'), { root: '/h/Code/factory-backups', everyMs: 6 * 3600000, keep: 14 });
  assert.deepEqual(backupPlan({ backup: { root: '~/b', everyHours: 24, keep: 3 } }, '/h'), { root: '/h/b', everyMs: 24 * 3600000, keep: 3 });
});
