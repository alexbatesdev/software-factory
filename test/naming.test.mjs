import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Alex 11-17: the factory, not a board. The old seat and role names may appear only where old labels must still match.
const DIRS = ['core', 'bin', 'fleet', 'views', 'mcp', 'effects', 'hosts', 'sources'];
const STALE = /board lead|board-lead|board developer|board-developer|Board Actions|triage board worker/i;
const ALLOWED = [/^views\/board\.mjs: const AGENT = /]; // the dashboard still counts old actors as agents

test('no code names the old board roles or seats again, outside the aliases that keep old labels working', () => {
  const hits = [];
  for (const d of DIRS) for (const f of readdirSync(new URL(`../${d}/`, import.meta.url)).filter(f => /\.(mjs|html|sh)$/.test(f))) {
    readFileSync(new URL(`../${d}/${f}`, import.meta.url), 'utf8').split('\n').forEach((line, i) => {
      const at = `${d}/${f}: ${line.trim()}`;
      if (STALE.test(line) && !ALLOWED.some(a => a.test(at))) hits.push(`${d}/${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(hits, []);
});
