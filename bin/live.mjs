#!/usr/bin/env node
// Live mode: V2 is the system of record. The first start imports V1's state.json once (V1 must be stopped);
// after that only this process writes the log. It polls, decides, messages and wakes seats, dispatches, marks PRs ready.
// Run: FACTORY_MODE=live node --env-file="$HOME/Code/teamwork mini mcp/.env" bin/live.mjs
if (process.env.FACTORY_MODE !== 'live') { console.error('Refusing to run: set FACTORY_MODE=live.'); process.exit(2); }
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openStore, derivedCtx } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';
import { importCommands } from '../core/import.mjs';
import { projectPrs, projectTasks, headCommands, healthCommands, recordPrKey, taskIdOf, projectCommands } from '../core/observe.mjs';
import { sourceCommands, sourceIndex } from '../core/correlate.mjs';
import { parseAcs } from '../core/derive.mjs';
import { inboxCommands } from '../core/inbox.mjs';
import { wakePlan } from '../core/wake.mjs';
import { autoDispatchPlan } from '../core/dispatch.mjs';
import { mergeCloses } from '../core/units.mjs';
import { TERMINAL, trackOf } from '../core/work.mjs';
import { readPrLines, readPrHealth, readPrs } from '../sources/github.mjs';
import { readTasks, readTopParents } from '../sources/teamwork.mjs';
import { list as readFleet } from '../fleet/herdr.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogWake } from '../wake/log.mjs';
import { autoReadyTick } from '../effects/pr-ready.mjs';
import { gh as liveGh } from '../effects/github.mjs';

// Dry run (FACTORY_DRY=1): a scratch DB from a copy of V1's state; reads are real, nothing is typed, marked or moved.
const DRY = process.env.FACTORY_DRY === '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const V1 = join(homedir(), 'Code/triage-board');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const supervisors = Object.keys(config.routing.supervisors);
const DB = process.env.FACTORY_DB || join(ROOT, 'data/factory.db');
const LOG = join(dirname(DB), 'live.log');
const run = promisify(execFile);
const gh = DRY ? { ...liveGh, ready: async url => { throw new Error(`dry run: would mark ${url} ready`); } } : liveGh;
const wake = DRY ? createLogWake(join(dirname(DB), 'would-wake.jsonl')) : (await import('../wake/herdr.mjs')).wake;
const PORT = Number(process.env.FACTORY_PORT || 4848);
const now = () => new Date().toISOString();
const log = (...a) => { console.log(now().slice(11, 19), ...a); appendFileSync(LOG, `${now()} ${a.join(' ')}\n`); };
const by = name => ({ now: now(), by: name });
// One command at a time: a refused observation is logged and the rest still land.
const apply = (cmds, who) => { for (const c of cmds) try { store.append(c, by(who)); } catch (e) { log(`refused ${c.kind} ${c.target || ''}: ${e.message}`); } };

// Two systems typing into panes at once is the failure cutover must avoid: V1 has to be down first.
if (!DRY && await fetch('http://127.0.0.1:4747/').then(() => true, () => false)) { console.error('V1 is still serving on :4747. Stop it first.'); process.exit(2); }
mkdirSync(dirname(DB), { recursive: true });
const store = openStore(DB, { supervisors });
if (store.state.seq === 0) {
  const cmds = importCommands(JSON.parse(readFileSync(process.env.FACTORY_IMPORT || join(V1, 'state.json'), 'utf8')), store.state);
  store.appendAll(cmds, by('import'));
  log(`final import from V1: ${cmds.length} rows`);
}
log(`${DRY ? 'DRY RUN' : 'live'}: ${DB} at seq ${store.state.seq}`);
// Intake triage covers records created since the final import, the moment V2 became the system of record.
const LIVE_SINCE = store.rows()[0]?.at || now();

let fleet = null, watches = {}, woken = {}, openPrs = new Map();
// A refusal that repeats every tick is logged once.
const seen = new Set(), once = line => { if (!seen.has(line)) { seen.add(line); log(line); } };
const quiet = {}, screens = {};

// Questions filed as JSON files (the pre-MCP path in the role files), same contract as V1's inbox folder.
const INBOX = join(V1, 'inbox');
function ingestInbox() {
  if (DRY || !existsSync(INBOX)) return;
  for (const d of ['done', 'rejected']) mkdirSync(join(INBOX, d), { recursive: true });
  for (const f of readdirSync(INBOX).filter(f => f.endsWith('.json'))) {
    const src = join(INBOX, f);
    try {
      const q = JSON.parse(readFileSync(src, 'utf8'));
      if (!q.from || !q.title || !Array.isArray(q.options) || q.options.length < 2 || q.options.some(o => !o.key || !o.text)) throw new Error('needs "from", "title" and at least two options with "key" and "text"');
      const work = q.work && store.state.work[q.work] ? q.work : (q.item && sourceIndex(store.state).get(q.item)) || null;
      const { id } = store.append({ kind: 'ask', payload: { ...q, work } }, by(String(q.from)));
      renameSync(src, join(INBOX, 'done', `${id}-${f}`));
      log(`question ${id} from ${q.from}`);
    } catch (e) { renameSync(src, join(INBOX, 'rejected', f)); writeFileSync(join(INBOX, 'rejected', `${f}.error.txt`), `${e.message}\n`); }
  }
}

// board.mjs files events here when V1 is down; V1 never comes back, so tell the seat instead of losing the write.
function retiredEvents() {
  const dir = join(INBOX, 'events');
  if (DRY || !existsSync(dir)) return;
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    let e = {}; try { e = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch {}
    const to = String(e.by || config.boardLead?.seat || 'board lead');
    renameSync(join(dir, f), join(dir, 'rejected', f));
    writeFileSync(join(dir, 'rejected', `${f}.error.txt`), 'board.mjs is retired (V2 cutover); redo it with the software-factory MCP tool.\n');
    apply([{ kind: 'message', payload: { to, work: e.work || null, about: { retired: f }, text: `[software factory] board.mjs is retired: your ${e.type || 'event'}${e.work ? ` on ${e.work}` : ''} was not recorded. Redo it with the software-factory MCP tool (file: inbox/events/rejected/${f}).` } }], 'board');
    log(`retired board.mjs event ${f} from ${to}`);
  }
}

function autoDispatchTick() {
  if (!config.autoDispatch?.enabled) return;
  const s = store.state;
  const views = Object.values(s.work).map(w => ({ ...w, ...derivedCtx(s, w.id) }));
  const terminals = [...(fleet?.others || []), ...(fleet?.units || []).flatMap(u => [u.supervisor, u.worker].filter(Boolean))].filter(a => a.workspace === 'Terminals').map(a => a.label);
  const plan = autoDispatchPlan(views, { supervisors: config.routing.supervisors, exclude: config.autoDispatch.exclude || [], mutationBranch: config.mutationBranch }, { terminals });
  for (const p of plan.filter(p => p.action)) {
    const w = s.work[p.id], who = 'board (auto-dispatch)';
    const cmds = [
      ...(p.owner ? [{ kind: 'update', target: p.id, payload: { stream: p.owner, ...(w.owner ? {} : { owner: p.owner }) } }] : []),
      { kind: 'event', target: p.id, payload: p.action === 'queue' ? { type: 'transition', to: 'queued' } : { type: 'request', request: 'dispatch' } },
      { kind: 'event', target: p.id, payload: { type: 'note', text: `Auto-dispatched to ${p.to}: ${p.reason}.` } },
    ];
    try { store.appendAll(cmds, by(who)); log(`dispatch ${p.id} -> ${p.to}`); } catch (e) { log(`dispatch ${p.id} refused: ${e.message}`); }
  }
}

async function inboxTick() {
  ingestInbox();
  retiredEvents();
  autoDispatchTick();
  const seats = [...supervisors, config.routing.questionsRouter, ...Object.keys(config.roles || {}), ...(config.factory?.seats || []).map(s => s.label)];
  const since = store.state.legacy.notifier?.activatedAt;
  const checkIn = config.boardLead?.checkIn !== false ? { seat: config.boardLead?.seat || 'board lead', now: now() } : null;
  const triage = { seat: config.boardLead?.seat || 'board lead', since: LIVE_SINCE };
  const plan = inboxCommands(store.state, { supervisors, seats, router: config.routing.questionsRouter, cutoff: since, answersSince: config.notify?.answersSince || since, checkIn, triage, quietMs: config.notify?.quietWorkerMs },
    fleet && { units: fleet.units, now: Date.now(), watches, quiet });
  watches = plan.watches;
  for (const c of plan.cmds) { store.append(c, by('board')); log(`message -> ${c.payload.to}: ${JSON.stringify(c.payload.about)}`); }
  for (const w of wakePlan(store.state, woken, Date.now(), config.notify?.reminderMs)) {
    const r = await wake(w).catch(e => ({ ok: false, reason: e.message }));
    if (r.ok) { woken[w.seat] = { at: Date.now(), ids: w.ids, reminded: w.reminder }; log(`woke ${w.seat}${w.reminder ? ' (reminder)' : ''}`); }
  }
  await autoReadyTick(store, gh, { standing: config.prReady?.enabled ? config.prReady.standing : null, isMutation: w => trackOf(w, config) === 'mutation', now, log: once });
}

async function githubTick() {
  try {
    const owner = config.githubOwner, s = store.state;
    const tracked = [...new Set(Object.values(s.work).filter(w => !TERMINAL.includes(w.phase)).map(w => recordPrKey(w, owner)).filter(Boolean))];
    const { lines, own } = await readPrLines({ owner, tracked });
    const { prs, heads } = projectPrs(lines, own);
    const health = await readPrHealth([...own], owner);
    apply([...headCommands(s, heads, { owner, now: now(), standingWaiver: config.standingWaiver }), ...healthCommands(s, health, { owner, now: now(), mutationBranch: config.mutationBranch, exclude: config.autoDispatch?.exclude })], 'github');
    apply(sourceCommands(store.state, prs, 'pr', parseAcs, { mutationBranch: config.mutationBranch, exclude: config.autoDispatch?.exclude }), 'poller');
    // PR states for the page and merge close: every PR a live record links.
    const links = [...new Set(Object.values(store.state.work).filter(w => !TERMINAL.includes(w.phase)).map(w => w.links?.pr).filter(Boolean))];
    openPrs = new Map((await readPrs(links)).map(p => [p.url, p]));
    await mergeTick();
    await alexReviewTick();
  } catch (e) { log(`github: ${e.message}`); }
}

// A record whose PR merged (or a task whose every PR merged) closes as merged, re-verified on a fresh read. Teamwork stays human.
async function mergeTick() {
  if (!config.mergeClose?.enabled) return;
  const s = store.state, bySource = Object.fromEntries(sourceIndex(s));
  for (const c of mergeCloses(s.work, bySource, { prState: u => openPrs.get(u)?.state || null, openQuestions: id => derivedCtx(s, id).openQuestions, track: w => trackOf(w, config) })) {
    const prs = await readPrs(c.prs);
    if (prs.length !== c.prs.length || prs.some(p => p.state !== 'MERGED')) continue;
    apply([{ kind: 'event', target: c.id, payload: { type: 'merged', prs } }], 'poller (merged)');
  }
}

// A trusted review of someone else's PR finishes on Alex's own submitted review, or the PR closing first.
async function alexReviewTick() {
  for (const w of Object.values(store.state.work).filter(x => x.reviews?.some(r => r.forAlex) && !TERMINAL.includes(x.phase) && x.links?.pr)) {
    try {
      const mine = (await gh.reviews(w.links.pr)).filter(r => r.login === config.githubLogin && r.state !== 'PENDING' && r.at && r.at > w.createdAt).at(-1);
      const pr = openPrs.get(w.links.pr);
      if (mine) apply([{ kind: 'event', target: w.id, payload: { type: 'alex_review_seen', review: { state: mine.state, at: mine.at, url: mine.url || null } } }], 'poller (GitHub reviews)');
      else if (pr && ['MERGED', 'CLOSED'].includes(pr.state)) apply([{ kind: 'event', target: w.id, payload: { type: 'alex_review_seen', closedAs: pr.state } }], 'poller (GitHub reviews)');
    } catch (e) { log(`review check ${w.id}: ${e.message}`); }
  }
}

const parents = new Map();
async function teamworkTick() {
  try { apply(sourceCommands(store.state, projectTasks(await readTasks(), process.env.TEAMWORK_SITE), 'teamwork', parseAcs), 'poller'); }
  catch (e) { log(`teamwork: ${e.message}`); }
  // Each record's project, for the page's "waiting on you" breakdown.
  try {
    const ids = [...new Set(Object.values(store.state.work).filter(w => !TERMINAL.includes(w.phase)).map(taskIdOf).filter(Boolean))];
    apply(projectCommands(store.state, await readTopParents(ids, parents)), 'teamwork');
  } catch (e) { log(`projects: ${e.message}`); }
}

// A working worker's screen with digits and symbols stripped: spinners and timers change, a stuck screen doesn't.
async function fleetTick() {
  try {
    fleet = await readFleet(store.state.legacy.pairs);
    for (const u of fleet.units) {
      if (u.worker?.status !== 'working') { delete quiet[u.id]; delete screens[u.id]; continue; }
      const stdout = await run('herdr', ['pane', 'read', u.worker.ref, '--source', 'visible', '--lines', '40'], { timeout: 5000 }).then(r => r.stdout, () => null);
      if (stdout == null) continue;
      const h = createHash('sha1').update(stdout.replace(/[^A-Za-z]+/g, '')).digest('hex');
      if (screens[u.id] !== h) { screens[u.id] = h; quiet[u.id] = Date.now(); }
    }
  } catch (e) { log(`fleet: ${e.message}`); }
}

http.createServer(createApi({ store, config, readPr: async url => (await readPrs([url]))[0] || null,
  observed: () => ({ units: fleet?.units || [], prs: openPrs, idleSince: watches.idleQueues || {}, graceMs: config.notify?.idleQueueGraceMs ?? 300000 }) }))
  .listen(PORT, '127.0.0.1', () => log(`API and page on http://127.0.0.1:${PORT}`));

const every = (ms, fn) => { let running = false; const run = async () => { if (running) return; running = true; try { await fn(); } catch (e) { log(e.message); } finally { running = false; } }; run(); setInterval(run, ms); };
await fleetTick();
every(config.poll.fleetMs, fleetTick);
every(config.notify?.intervalMs ?? 15000, inboxTick);
every(config.poll.githubMs, githubTick);
every(config.poll.teamworkMs, teamworkTick);
