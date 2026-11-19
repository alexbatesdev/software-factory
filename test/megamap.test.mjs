// W-574: the megamap web viewer mounted in the factory's own origin at /megamap/, from trusted config only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { megamapMount, projectFor } from '../hosts/megamap.mjs';
import { openStore } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';

const STUB = fileURLToPath(new URL('./fixtures/megamap-stub.mjs', import.meta.url));
const dir = mkdtempSync(`${tmpdir()}/spamton-mm-`), bin = `${dir}/megamap-data`;
writeFileSync(bin, '');
const cfg = (over = {}) => ({ module: STUB, binary: bin, allowCapture: false, projects: [{ id: 'app', label: 'App', root: dir, repo: 'app' }, { id: 'gone', label: 'Gone', root: `${dir}/missing`, repo: 'gone' }], ...over });

async function serve(mount) {
  const store = openStore(':memory:', { supervisors: [] });
  const server = http.createServer(createApi({ store, config: { roles: {}, routing: { supervisors: {} } }, mounts: mount ? [mount] : [] }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

test('the module is mounted at /megamap/ with only configured projects whose roots exist, the binary and capture off', async () => {
  const m = await megamapMount(cfg());
  assert.equal(m.available, true);
  const f = await serve(m);
  try {
    const r = await (await fetch(`${f.base}/megamap/api/config`)).json();
    assert.deepEqual(r.projects, [{ id: 'app', label: 'App', root: dir }], 'a project whose root is missing is left out');
    assert.deepEqual([r.binary, r.allowCapture], [bin, false]);
    assert.equal((await fetch(`${f.base}/api/board`)).status, 200, "the factory's own routes still answer");
  } finally { f.close(); await m.close(); }
});

test('a missing module or binary serves a clear unavailable page and never stops the factory', async () => {
  for (const [over, what] of [[{ module: `${dir}/nope.mjs` }, /module/], [{ binary: `${dir}/nope` }, /binary/]]) {
    const m = await megamapMount(cfg(over));
    assert.equal(m.available, false);
    const f = await serve(m);
    try {
      const r = await fetch(`${f.base}/megamap/`);
      assert.equal(r.status, 503);
      assert.match(await r.text(), what);
      assert.equal((await fetch(`${f.base}/api/board`)).status, 200);
    } finally { f.close(); }
  }
  assert.equal(await megamapMount(null), null, 'not configured: no route at all');
});

test('a module that throws on load is unavailable too, with its error', async () => {
  const bad = `${dir}/bad.mjs`; writeFileSync(bad, 'throw new Error("boom at load")');
  const m = await megamapMount(cfg({ module: bad }));
  assert.equal(m.available, false);
  assert.match(m.missing.join(), /boom at load/);
});

test("a record's code-map link is its repo's configured project, never a path", () => {
  const c = cfg();
  assert.equal(projectFor(c, { repo: 'app' })?.id, 'app');
  assert.equal(projectFor(c, { repo: null }, 'app')?.id, 'app', 'no repo: the default repo');
  assert.equal(projectFor(c, { repo: 'other' }), null);
});

test("each card links to its repo's code map, and the board says whether megamap is configured (W-574)", async () => {
  const store = openStore(':memory:', { supervisors: [] });
  store.append({ kind: 'create', payload: { title: 'in app', repo: 'app' } }, { now: '2026-11-19T20:00:00Z', by: 't' });
  store.append({ kind: 'create', payload: { title: 'elsewhere', repo: 'other' } }, { now: '2026-11-19T20:00:00Z', by: 't' });
  const server = http.createServer(createApi({ store, config: { roles: {}, routing: { supervisors: {} }, megamap: cfg() } }));
  await new Promise(ok => server.listen(0, '127.0.0.1', ok));
  try {
    const b = await (await fetch(`http://127.0.0.1:${server.address().port}/api/board`)).json();
    const card = id => b.cards.find(c => c.id === id);
    assert.equal(card('W-1').map, '/megamap/?project=app');
    assert.equal(card('W-2').map, null);
    assert.equal(b.megamap, true);
  } finally { server.close(); }
});

test('configured paths may start with ~/, expanded on this host', async () => {
  const { homedir } = await import('node:os');
  const m = await megamapMount({ module: '~/definitely-not-here/server.mjs', binary: bin, projects: [{ id: 'app', label: 'App', root: dir, repo: 'app' }] });
  assert.match(m.missing.join(), new RegExp(`module: nothing at ${homedir()}/definitely-not-here/server.mjs`));
});

test('an unavailable mount picks the module up once it is installed, on a later request, with no factory restart', async () => {
  const { retryingMount } = await import('../hosts/megamap.mjs');
  let now = 0, installed = false;
  const mount = async () => installed ? megamapMount(cfg()) : megamapMount(cfg({ module: `${dir}/not-yet.mjs` }));
  const r = await retryingMount(cfg(), { mount, clock: () => now, everyMs: 30000 });
  const f = await serve(r);
  try {
    assert.equal((await fetch(`${f.base}/megamap/`)).status, 503);
    installed = true;
    assert.equal((await fetch(`${f.base}/megamap/`)).status, 503, 'not re-checked within 30 s');
    now = 31000;
    assert.equal((await fetch(`${f.base}/megamap/api/config`)).status, 200, 'mounted once installed');
    assert.equal(r.available, true);
  } finally { f.close(); await r.close(); }
});

test('a record with a PR in a configured project links to that PR in Megamap; others get no PR link (W-597)', async () => {
  const { prMapFor } = await import('../hosts/megamap.mjs');
  const cfg = { projects: [{ id: 'built-rails', repo: 'built-rails' }, { id: 'sf', repo: 'software-factory' }] };
  assert.equal(prMapFor(cfg, { links: { pr: 'https://github.com/acme/built-rails/pull/8968' } }), '/megamap/?project=built-rails&pr=8968');
  assert.equal(prMapFor(cfg, { repo: 'built-rails', links: { pr: 'https://github.com/acme/software-factory/pull/12' } }), '/megamap/?project=sf&pr=12', "the PR's own repo picks the project");
  assert.equal(prMapFor(cfg, { links: { pr: 'https://github.com/acme/other-repo/pull/5' } }), null, 'no configured project for that repo');
  assert.equal(prMapFor(cfg, { links: {} }), null);
  assert.equal(prMapFor(null, { links: { pr: 'https://github.com/acme/built-rails/pull/1' } }), null, 'megamap not configured');
});
