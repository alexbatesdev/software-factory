#!/usr/bin/env node
// Compare what V2 would have told each seat with what V1 actually told it, by subject, since the shadow run started.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WOULD = join(ROOT, 'data/shadow/would.jsonl');
const lines = (existsSync(WOULD) ? readFileSync(WOULD, 'utf8') : '').split('\n').filter(Boolean).map(l => JSON.parse(l));
const start = process.argv[2] || lines[0]?.at || new Date().toISOString();
const v2 = new Map(), v1 = new Map();
const keysOf = about => Object.entries(about || {}).flatMap(([k, v]) => [v].flat().map(x => `${k}:${x}`));
for (const l of lines) if (l.kind === 'message') for (const k of keysOf(l.about)) v2.set(k, { to: l.to, at: l.at });
const notes = JSON.parse(readFileSync(join(homedir(), 'Code/triage-board/state.json'), 'utf8')).notifications;
for (const n of Object.values(notes)) {
  if (n.at < start || n.status !== 'submitted') continue;
  for (const k of [...(n.requests || []).map(r => `requests:${r}`), ...(n.answers || []).map(a => `answers:${a}`), ...(n.workerStop ? [`workerStop:${n.workerStop}`] : []), ...(n.idleQueue ? [`idleQueue:${n.idleQueue}`] : [])])
    v1.set(k, { to: n.to?.label || n.to?.name, at: n.at });
}
const both = [...v2].filter(([k, x]) => v1.has(k)), wrongSeat = both.filter(([k, x]) => v1.get(k).to !== x.to);
const only = (a, b) => [...a].filter(([k]) => !b.has(k));
console.log(`since ${start}: ${both.length} subjects told by both (${wrongSeat.length} to a different seat), ${only(v2, v1).length} V2 only, ${only(v1, v2).length} V1 only`);
for (const [k, x] of wrongSeat) console.log(`  seat differs ${k}: V2 ${x.to}, V1 ${v1.get(k).to}`);
for (const [k, x] of only(v2, v1)) console.log(`  V2 only ${k} -> ${x.to} at ${x.at}`);
for (const [k, x] of only(v1, v2)) console.log(`  V1 only ${k} -> ${x.to} at ${x.at}`);
const records = lines.filter(l => l.kind === 'record');
console.log(`record changes V2 would have appended: ${records.length}`);
for (const r of records.slice(-20)) console.log(`  ${r.at.slice(11, 19)} ${r.command} ${r.target || r.payload?.id || ''}`);
