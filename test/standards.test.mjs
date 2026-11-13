import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncStandards } from '../hosts/standards.mjs';

test("The standards documents are mirrored where workers can read them, and only rewritten when they change", () => {
  const src = mkdtempSync(join(tmpdir(), 'std-src-')), dst = join(mkdtempSync(join(tmpdir(), 'std-dst-')), 'standards');
  writeFileSync(join(src, 'DEFINITION_OF_DONE.md'), 'dod v1'); writeFileSync(join(src, 'WWBD.md'), 'wwbd v1');
  assert.deepEqual(syncStandards(src, dst), ['DEFINITION_OF_DONE.md', 'WWBD.md']);
  assert.deepEqual(syncStandards(src, dst), []);
  writeFileSync(join(src, 'WWBD.md'), 'wwbd v2');
  assert.deepEqual(syncStandards(src, dst), ['WWBD.md']);
  assert.equal(readFileSync(join(dst, 'WWBD.md'), 'utf8'), 'wwbd v2');
});

import { standardsClaudeMd } from '../hosts/standards.mjs';
test("a sandbox's own CLAUDE.md carries both documents in full, so every worker session loads them", () => {
  const src = mkdtempSync(join(tmpdir(), 'std-src-'));
  writeFileSync(join(src, 'DEFINITION_OF_DONE.md'), '# Definition of Done\ngate one'); writeFileSync(join(src, 'WWBD.md'), '# How We Work\ninstinct one');
  const md = standardsClaudeMd(src);
  assert.match(md, /gate one/); assert.match(md, /instinct one/);
  assert.match(md, /^# Team standards/);
});
