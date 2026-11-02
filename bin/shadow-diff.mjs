#!/usr/bin/env node
// Compare what V2 would have told each seat with what V1 actually told it, by subject, since the shadow run started.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The newest run unless one is named: node bin/shadow-diff.mjs [run-folder] [since-ISO]
const runs = existsSync(join(ROOT, 'data/shadow')) ? readdirSync(join(ROOT, 'data/shadow')).filter(d => /^\d{8}T\d{4}$/.test(d)).sort() : [];
const RUN = process.argv[2] || runs.at(-1) || '';
const WOULD = join(ROOT, 'data/shadow', RUN, 'would.jsonl');
const lines = (existsSync(WOULD) ? readFileSync(WOULD, 'utf8') : '').split('\n').filter(Boolean).map(l => JSON.parse(l));
const start = process.argv[3] || lines[0]?.at || new Date().toISOString();
const v2 = new Map(), v1 = new Map();
const keysOf = about => Object.entries(about || {}).flatMap(([k, v]) => [v].flat().map(x => `${k}:${x}`));
for (const l of lines) if (l.kind === 'message') for (const k of keysOf(l.about)) v2.set(k, { to: l.to, at: l.at });
const V1 = JSON.parse(readFileSync(join(homedir(), 'Code/triage-board/state.json'), 'utf8'));
const notes = V1.notifications;
// V1 tells from before the start still count as told, so a subject V1 told seconds before V2 started isn't "V2 only".
const v1Early = new Set();
for (const n of Object.values(notes)) {
  if (n.status !== 'submitted') continue;
  for (const k of [...(n.requests || []).map(r => `requests:${r}`), ...(n.answers || []).map(a => `answers:${a}`), ...(n.workerStop ? [`workerStop:${n.workerStop}`] : []), ...(n.idleQueue ? [`idleQueue:${n.idleQueue}`] : [])])
    n.at < start ? v1Early.add(k) : v1.set(k, { to: n.to?.label || n.to?.name, at: n.at });
}
// Timing, not disagreement: the seat acked a request before V1 could type into it (V1 waits for an idle pane, as V2's
// wake does, and V2 closes the message on the ack), or an answer was acked before the shadow's next import saw it.
const reqOf = k => { const [w, r] = k.slice(9).split('/'); return V1.work[w]?.requests.find(x => x.id === r); };
const ansOf = k => V1.questions[k.slice(8)];
const timing = ([k, x]) => v1Early.has(k) && !k.startsWith('workerStop:')
  || k.startsWith('requests:') && reqOf(k)?.ack?.by === x.to
  || k.startsWith('answers:') && ansOf(k)?.answer?.ack && Date.parse(ansOf(k).answer.ack.at) - Date.parse(x.at) < 30000;
const both = [...v2].filter(([k, x]) => v1.has(k)), wrongSeat = both.filter(([k, x]) => v1.get(k).to !== x.to);
const only = (a, b) => [...a].filter(([k]) => !b.has(k));
const [v2Only, v1Only] = [only(v2, v1), only(v1, v2)], late = [...v2Only, ...v1Only].filter(timing);
const real = l => l.filter(e => !timing(e));
console.log(`since ${start}: ${both.length} subjects told by both (${wrongSeat.length} to a different seat), ${real(v2Only).length} V2 only, ${real(v1Only).length} V1 only, ${late.length} timing`);
for (const [k, x] of wrongSeat) console.log(`  seat differs ${k}: V2 ${x.to}, V1 ${v1.get(k).to}`);
for (const [k, x] of real(v2Only)) console.log(`  V2 only ${k} -> ${x.to} at ${x.at}`);
for (const [k, x] of real(v1Only)) console.log(`  V1 only ${k} -> ${x.to} at ${x.at}`);
for (const [k, x] of late) console.log(`  timing ${k} -> ${x.to} at ${x.at}`);
// A record change V1 has since made itself is timing (the pollers run at different points in their cycle), not a disagreement.
const caughtUp = r => {
  const w = V1.work[r.target];
  // V1 verifying any head after V2's read means V2's read is stale on both sides; a live disagreement keeps re-logging.
  if (r.command === 'observe_head') return w?.head === r.payload.sha || w?.headVerified?.at > r.at;
  if (r.command === 'unverify_head') return !w?.headVerified;
  if (r.command === 'source_gone') return w?.upstream === 'gone';
  if (r.command === 'observe_source') return !!(V1.workBySource[r.payload.id] || Object.values(V1.work).some(x => (x.aliases || []).includes(r.payload.id)));
  return false;
};
const records = lines.filter(l => l.kind === 'record'), open = [...new Map(records.filter(r => !caughtUp(r)).map(r => [`${r.command} ${r.target || r.payload?.id}`, r])).values()];
console.log(`record changes V2 would have appended: ${records.length}; ${records.length - records.filter(r => !caughtUp(r)).length} since made by V1, ${open.length} distinct not made by V1:`);
for (const r of open) console.log(`  ${r.at.slice(11, 19)} ${r.command} ${r.target || r.payload?.id || ''} ${r.payload?.sha || ''}`);
