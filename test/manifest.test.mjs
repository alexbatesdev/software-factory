import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../core/store.mjs';
import { captureManifests, MANIFEST_FROM } from '../core/manifest.mjs';
import { checkConfig } from '../core/preflight.mjs';

// Evolution phase 1 step 3: what a run actually ran with, kept so a later reader needn't trust today's files.
const SUP = 'sup: stream-2', T = '2026-11-13T18:00:00.000Z';
const sha = s => createHash('sha256').update(s).digest('hex');

function started(at = T) {
  const store = openStore(':memory:', { supervisors: [SUP] });
  store.append({ kind: 'create', payload: { title: 'x', stream: SUP } }, { now: at, by: SUP });
  const w = store.state.work['W-1'];
  Object.assign(w, { stream: SUP, head: 'b'.repeat(40) });
  w.assignments = [{ id: 'R1', kind: 'implementation', owner: 'sbx: stream-2', status: 'started', version: 1, brief: null,
    evidence: 'Brief ~/Code/plans/w1-r1-brief.md (VM /tmp/brief/).', at, history: [{ status: 'queued', at }, { status: 'started', at }], startedFrom: { head: 'c'.repeat(40) } }];
  return store;
}

const FILES = { '/h/Code/plans/w1-r1-brief.md': 'brief text', '/h/role.md': 'role', '/h/dod.md': 'dod' };
const io = root => ({ root, now: () => T, home: '/h', factoryVersion: 'abc1234', config: '{"a":1}',
  instructions: { 'stream-supervisor role': '/h/role.md', 'definition of done': '/h/dod.md', 'internal review (codex)': '/h/missing.md' },
  read: async p => { if (!(p in FILES)) throw new Error(`ENOENT ${p}`); return Buffer.from(FILES[p]); },
  harness: stream => stream === SUP ? { agent: 'codex', sandbox: 'herdr-x', model: 'gpt-5.6-sol', effort: 'high' } : null });

test('a started run gets one manifest: identity, code, config, harness, and each instruction file kept by hash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'spamton-mf-'));
  const store = started();
  await captureManifests(store, io(root));
  await captureManifests(store, io(root));
  const all = Object.values(store.state.manifests);
  assert.equal(all.length, 1, 'once per attempt');
  const [m] = all;
  assert.deepEqual(m.run, { work: 'W-1', assignment: 'R1', version: 1, attempt: 1, kind: 'implementation', owner: 'sbx: stream-2', stream: SUP });
  assert.deepEqual([m.startHead, m.factoryVersion, m.config], ['c'.repeat(40), 'abc1234', sha('{"a":1}')]);
  assert.deepEqual(m.harness, { agent: 'codex', sandbox: 'herdr-x', model: { requested: 'gpt-5.6-sol', observed: 'unavailable' }, effort: { requested: 'high', observed: 'unavailable' } });
  const by = Object.fromEntries(m.instructions.map(i => [i.name, i]));
  assert.equal(by.brief.sha256, sha('brief text'));
  assert.equal(readFileSync(join(root, sha('brief text').slice(0, 2), sha('brief text')), 'utf8'), 'brief text');
  assert.equal(by['definition of done'].sha256, sha('dod'));
  assert.deepEqual([by['internal review (codex)'].sha256, by['internal review (codex)'].unavailable], [null, 'ENOENT /h/missing.md']);
});

test('a run started before manifests existed is left alone', async () => {
  const store = started('2026-11-12T00:00:00.000Z');
  assert.ok('2026-11-12T00:00:00.000Z' < MANIFEST_FROM);
  await captureManifests(store, io(tmpdir()));
  assert.deepEqual(store.state.manifests || {}, {});
});

test('config preflight names what the runtime would trip on: unknown roles, harnesses, worker labels, files and record ids', () => {
  const ROLES = { 'stream-supervisor': [], 'board-developer': [] }, exists = p => !p.includes('missing');
  const ok = { roles: { 'triage board worker': 'board-developer' }, routing: { supervisors: { 'sup: s1': { worker: 'sbx: s1' }, 'sup: s2': { worker: 'sbx: s2', agent: 'codex' }, 'sup: host': { howTo: '~/x.md' } } },
    recycle: { host: 'sbx' }, factory: { seats: [{ label: 'board lead', role: 'board-developer' }] }, autoDispatch: { exclude: ['W-1'] } };
  assert.deepEqual(checkConfig(ok, { roles: ROLES, exists }), []);
  const bad = { roles: { x: 'no-such-role' }, routing: { supervisors: { 'sup: s1': { worker: 'stream-1' }, 'sup: s2': { worker: 'sbx: s2', agent: 'gemini' }, 'sup: host': { howTo: '~/missing.md' } } },
    recycle: { host: 'missing-host' }, factory: { seats: [{ label: 'y', role: 'nobody' }] }, autoDispatch: { exclude: ['nope'] } };
  const found = checkConfig(bad, { roles: ROLES, exists }).join('\n');
  for (const want of [/no-such-role/, /"stream-1"/, /gemini/, /missing\.md/, /missing-host/, /nobody/, /"nope"/]) assert.match(found, want);
});
