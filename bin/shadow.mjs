#!/usr/bin/env node
// Shadow mode: V1 stays the system of record. This re-imports V1's state.json whenever it changes, reads the same sources,
// and records what V2 would do: its own messages and wakes, plus the record changes it would append. It types nothing.
// Run: FACTORY_MODE=shadow node --env-file="$HOME/Code/teamwork mini mcp/.env" bin/shadow.mjs
if (process.env.FACTORY_MODE !== 'shadow') { console.error('Refusing to run: set FACTORY_MODE=shadow.'); process.exit(2); }
import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openStore } from '../core/store.mjs';
import { importCommands } from '../core/import.mjs';
import { projectPrs, projectTasks, headCommands, recordPrKey } from '../core/observe.mjs';
import { sourceCommands } from '../core/correlate.mjs';
import { parseAcs } from '../core/derive.mjs';
import { inboxCommands, toldKeys } from '../core/inbox.mjs';
import { wakePlan } from '../core/wake.mjs';
import { TERMINAL } from '../core/work.mjs';
import { createLogWake } from '../wake/log.mjs';
import { readPrLines } from '../sources/github.mjs';
import { readTasks } from '../sources/teamwork.mjs';
import { list as readFleet } from '../fleet/herdr.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V1_STATE = join(homedir(), 'Code/triage-board/state.json');
// Each run gets its own folder, so a run never inherits an earlier one's log.
const OUT = join(ROOT, 'data/shadow', new Date().toISOString().slice(0, 16).replace(/[-:]/g, ''));
mkdirSync(OUT, { recursive: true });
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const supervisors = Object.keys(config.routing.supervisors);
const store = openStore(join(OUT, 'shadow.db'), { supervisors });
const would = (kind, data) => appendFileSync(join(OUT, 'would.jsonl'), JSON.stringify({ at: new Date().toISOString(), kind, ...data }) + '\n');
const wake = createLogWake(join(OUT, 'would.jsonl'));
const now = () => new Date().toISOString();
const log = (...a) => console.log(now().slice(11, 19), ...a);
const STARTED = now();

let v1Mtime = 0;
function reimport() {
  const m = statSync(V1_STATE).mtimeMs;
  if (m === v1Mtime) return;
  // V1 rewrites the whole file; a half-written read fails to parse and is retried next tick.
  let v1; try { v1 = JSON.parse(readFileSync(V1_STATE, 'utf8')); } catch { return; }
  v1Mtime = m;
  const cmds = importCommands(v1, store.state);
  if (cmds.length) { store.appendAll(cmds, { now: now(), by: 'import' }); log(`imported ${cmds.length} change(s) from V1`); }
}

let watches = {}, woken = {}, fleet = null;
async function inboxTick() {
  reimport();
  const seats = [...supervisors, config.routing.questionsRouter, ...Object.keys(config.roles || {}), ...(config.factory?.seats || []).map(s => s.label)];
  const since = store.state.legacy.notifier?.activatedAt;
  const plan = inboxCommands(store.state, { supervisors, seats, router: config.routing.questionsRouter, cutoff: since, answersSince: config.notify?.answersSince || since, v1Before: STARTED }, fleet && { units: fleet.units, now: Date.now(), watches });
  watches = plan.watches;
  for (const c of plan.cmds) { store.append(c, { now: now(), by: 'board' }); would('message', c.payload); log(`message -> ${c.payload.to}: ${JSON.stringify(c.payload.about)}`); }
  // Seats ack in V1, never in V2: a shadow message closes, as its addressee, once V1 told the same subject or the request was acked.
  const v1Told = toldKeys({ messages: {}, notifications: store.state.notifications });
  // (all V1 notices here, including ones after STARTED: closing a message is bookkeeping, not a decision)
  const acked = key => { const [w, r] = key.split('/'); return !!store.state.work[w]?.requests.find(x => x.id === r)?.ack; };
  for (const m of Object.values(store.state.messages)) {
    if (m.ackedAt) continue;
    const keys = Object.entries(m.about || {}).flatMap(([k, v]) => [v].flat().map(x => `${k}:${x}`));
    if (keys.some(k => v1Told.has(k) || k.startsWith('requests:') && acked(k.slice(9)))) store.append({ kind: 'ack_message', target: m.id, payload: { outcome: 'closed in V1' } }, { now: now(), by: m.to });
  }
  for (const w of wakePlan(store.state, woken, Date.now(), config.notify?.reminderMs)) {
    await wake(w);
    woken[w.seat] = { at: Date.now(), ids: w.ids, reminded: w.reminder };
  }
}

async function githubTick() {
  try {
    const owner = config.githubOwner, s = store.state;
    const tracked = [...new Set(Object.values(s.work).filter(w => !TERMINAL.includes(w.phase)).map(w => recordPrKey(w, owner)).filter(Boolean))];
    const { lines, own } = await readPrLines({ owner, tracked });
    const { prs, heads } = projectPrs(lines, own);
    for (const c of [...headCommands(s, heads, { owner, now: now(), standingWaiver: config.standingWaiver }), ...sourceCommands(s, prs, 'pr', parseAcs, { mutationBranch: config.mutationBranch, exclude: config.autoDispatch?.exclude })])
      would('record', { command: c.kind, target: c.target, payload: c.kind === 'observe_source' ? { id: c.payload.id } : c.payload });
  } catch (e) { log(`github: ${e.message}`); }
}
async function teamworkTick() {
  try { for (const c of sourceCommands(store.state, projectTasks(await readTasks(), process.env.TEAMWORK_SITE), 'teamwork', parseAcs)) would('record', { command: c.kind, target: c.target, payload: c.kind === 'observe_source' ? { id: c.payload.id } : c.payload }); }
  catch (e) { log(`teamwork: ${e.message}`); }
}
async function fleetTick() { try { fleet = await readFleet(store.state.legacy.pairs); } catch (e) { log(`fleet: ${e.message}`); } }

const every = (ms, fn) => { const run = () => fn().catch(e => log(e.message)); run(); setInterval(run, ms); };
log(`shadow mode: V1 ${V1_STATE} → ${OUT}`);
reimport();
every(config.poll.fleetMs, fleetTick);
every(config.notify?.intervalMs ?? 15000, inboxTick);
every(config.poll.githubMs, githubTick);
every(config.poll.teamworkMs, teamworkTick);
