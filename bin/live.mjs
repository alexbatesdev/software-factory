#!/usr/bin/env node
// Live mode: V2 is the system of record; only this process writes the log. It polls, decides, messages and wakes seats, dispatches, marks PRs ready.
// Run: FACTORY_MODE=live node --env-file="$HOME/Code/teamwork mini mcp/.env" bin/live.mjs
if (process.env.FACTORY_MODE !== 'live') { console.error('Refusing to run: set FACTORY_MODE=live.'); process.exit(2); }
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, derivedCtx } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';
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
import { planRecycles } from '../core/recycle.mjs';
import { gh as liveGh } from '../effects/github.mjs';

// Dry run (FACTORY_DRY=1, FACTORY_DB=<a copy of data/factory.db>): reads are real, nothing is typed, marked or moved.
const DRY = process.env.FACTORY_DRY === '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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

mkdirSync(dirname(DB), { recursive: true });
const store = openStore(DB, { supervisors });
log(`${DRY ? 'DRY RUN' : 'live'}: ${DB} at seq ${store.state.seq}`);
// Intake triage covers records created since the final import, the moment V2 became the system of record.
const LIVE_SINCE = store.rows()[0]?.at || now();

let fleet = null, watches = {}, woken = {}, openPrs = new Map(), lastPlan = [];
// Worker hosts (Alex, 11-04): disk readings, cycles under way or failed, and the streams draining for one.
const RC = { enabled: false, threshold: 0.75, host: 'sbx', healthMs: 300000, ...config.recycle };
const host = RC.enabled ? await import(`../hosts/${RC.host}.mjs`) : null;
let health = {}, recycling = {}, drain = new Map();
// A refusal that repeats every tick is logged once.
const seen = new Set(), once = line => { if (!seen.has(line)) { seen.add(line); log(line); } };
const quiet = {}, screens = {};

// Questions filed as JSON files, the fallback when a seat's MCP tools are down (~/Code/CLAUDE.md).
const INBOX = join(ROOT, 'inbox');
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

function autoDispatchTick() {
  if (!config.autoDispatch?.enabled) return;
  const s = store.state;
  const views = Object.values(s.work).map(w => ({ ...w, ...derivedCtx(s, w.id) }));
  const terminals = [...(fleet?.others || []), ...(fleet?.units || []).flatMap(u => [u.supervisor, u.worker].filter(Boolean))].filter(a => a.workspace === 'Terminals').map(a => a.label);
  const plan = autoDispatchPlan(views, { supervisors: config.routing.supervisors, exclude: config.autoDispatch.exclude || [], mutationBranch: config.mutationBranch, drain }, { terminals });
  lastPlan = plan;
  for (const p of plan.filter(p => p.action === 'resume')) {
    const key = `${p.id}/${p.assignmentId}/v${p.version}`;
    if (Object.values(store.state.messages).some(m => m.about?.resume === key)) continue;
    apply([{ kind: 'message', payload: { to: p.to, work: p.id, about: { resume: key }, text: `[software factory] Resume ${p.id} ${p.assignmentId}: ${p.reason}. Brief a fresh worker from its handoff, then progress ${p.assignmentId} --stage started.` } },
      { kind: 'event', target: p.id, payload: { type: 'note', text: `Resume sent to ${p.to}: ${p.reason}.` } }], 'board (auto-dispatch)');
    log(`resume ${p.id} ${p.assignmentId} -> ${p.to}`);
  }
  for (const p of plan.filter(p => p.action && p.action !== 'resume')) {
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
  autoDispatchTick();
  const seats = [...supervisors, config.routing.questionsRouter, ...Object.keys(config.roles || {}), ...(config.factory?.seats || []).map(s => s.label)];
  const since = store.state.legacy.notifier?.activatedAt;
  const checkIn = config.boardLead?.checkIn !== false ? { seat: config.boardLead?.seat || 'board lead', now: now() } : null;
  const triage = { seat: config.boardLead?.seat || 'board lead', since: LIVE_SINCE };
  const plan = inboxCommands(store.state, { supervisors, seats, router: config.routing.questionsRouter, cutoff: since, answersSince: config.notify?.answersSince || since, checkIn, triage, quietMs: config.notify?.quietWorkerMs },
    fleet && { units: fleet.units, others: fleet.others, now: Date.now(), watches, quiet, drain });
  watches = plan.watches;
  for (const c of plan.cmds) { store.append(c, by('board')); log(`message -> ${c.payload.to}: ${JSON.stringify(c.payload.about)}`); }
  const sessions = Object.fromEntries([...(fleet?.others || []), ...(fleet?.units || []).flatMap(u => [u.supervisor, u.worker].filter(Boolean))].map(a => [a.label, a.session]));
  for (const w of wakePlan(store.state, woken, Date.now(), config.notify?.reminderMs, sessions)) {
    const r = await wake(w).catch(e => ({ ok: false, reason: e.message }));
    if (r.ok) { woken[w.seat] = { at: Date.now(), ids: w.ids, reminded: w.reminder, session: r.session }; log(`woke ${w.seat}${w.reminder ? ' (reminder)' : ''}`); }
  }
}

// Marking PRs ready waits on GitHub; on its own loop so a slow GitHub never holds up messages and wakes (W-199).
const readyTick = () => autoReadyTick(store, gh, { standing: config.prReady?.enabled ? config.prReady.standing : null, isMutation: w => trackOf(w, config) === 'mutation', now, log: once });

async function githubTick() {
  try {
    const owner = config.githubOwner, s = store.state;
    const tracked = [...new Set(Object.values(s.work).filter(w => !TERMINAL.includes(w.phase)).map(w => recordPrKey(w, owner)).filter(Boolean))];
    const { lines, own } = await readPrLines({ owner, tracked });
    const { prs, heads } = projectPrs(lines, own);
    const health = await readPrHealth([...own], owner, undefined, config.githubLogin);
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
  observed: () => ({ units: fleet?.units || [], prs: openPrs, idleSince: watches.idleQueues || {}, graceMs: config.notify?.idleQueueGraceMs ?? 300000, queue: lastPlan, drain, health }) }))
  .listen(PORT, '127.0.0.1', () => log(`API and page on http://127.0.0.1:${PORT}`));

// Read each worker's disk, drain full ones, and cycle a drained worker once it is between tasks.
async function recycleTick() {
  if (!host || !fleet) return;
  for (const u of fleet.units.filter(u => supervisors.includes(u.supervisor?.label) && (u.worker?.sandbox || RC.host !== 'sbx'))) {
    try { health[u.id] = await host.health(u.worker); } catch (e) { once(`health ${u.worker?.label}: ${e.message}`); }
  }
  const plan = planRecycles({ units: fleet.units, health, works: store.state.work, threshold: RC.threshold, recycling, supervisors });
  drain = plan.drain;
  for (const d of plan.due) {
    const tell = (to, about, text) => apply([{ kind: 'message', payload: { to, about, text: `[software factory] ${text}` } }], 'board');
    const found = await host.preflight(d.worker).catch(e => [{ path: '(preflight)', problem: e.message, blocking: true }]);
    const problems = found.filter(p => p.blocking), dropped = found.filter(p => !p.blocking).map(p => `${p.path}: ${p.problem}`).join('; ');
    if (problems.length) {
      const key = `${d.worker.sandbox}/${problems.length}`, list = problems.map(p => `${p.path}: ${p.problem}`).join('; ');
      if (!Object.values(store.state.messages).some(m => m.about?.recycleBlocked === key))
        for (const to of [d.to, config.boardLead?.seat || 'board lead']) tell(to, { recycleBlocked: key }, `${d.worker.label} is due a recycle (disk ${Math.round(d.diskPct * 100)}%), but this work would be lost with it: ${list}. Push or discard it; the factory retries on its next disk check.`);
      continue;
    }
    if (DRY) { once(`dry run: would recycle ${d.worker.label} (${d.worker.sandbox})`); continue; }
    recycling[d.unit] = { step: 'replacing the sandbox' };
    drain.set(d.to, `recycling ${d.worker.label}`);
    log(`recycle ${d.worker.label}: starting (disk ${Math.round(d.diskPct * 100)}%)`);
    const r = await host.recycle(d.worker, log).catch(e => ({ ok: false, detail: e.message }));
    log(`recycle ${d.worker.label}: ${r.ok ? 'done' : 'FAILED'}: ${r.detail}`);
    if (r.ok) { delete recycling[d.unit]; delete health[d.unit]; tell(d.to, { recycled: `${d.worker.sandbox}/${now()}` }, `${d.worker.label} was recycled (fresh sandbox, clean disk). It has none of its earlier context; brief it cold. If its pane shows Claude's bypass-permissions prompt, that one is Alex's to accept: ask local-head to tell him.${dropped ? ` Discarded with the old sandbox (replaced or stale): ${dropped}.` : ''}`); }
    else { recycling[d.unit] = { step: 'failed', failed: r.detail }; tell(config.boardLead?.seat || 'board lead', { recycleFailed: `${d.worker.sandbox}/${now()}` }, `Recycling ${d.worker.label} failed: ${r.detail}. Its stream takes no new work until this is fixed; file it as a factory record.`); }
  }
}

// A tick still running skips the next; one slower than a minute is logged so a stalled loop names itself.
const every = (ms, fn) => { let running = false; const run = async () => { if (running) return; running = true; const t0 = Date.now(); try { await fn(); } catch (e) { log(e.message); } finally { running = false; if (Date.now() - t0 > 60000) log(`slow tick: ${fn.name || 'tick'} took ${Math.round((Date.now() - t0) / 1000)}s`); } }; run(); setInterval(run, ms); };
await fleetTick();
every(config.poll.fleetMs, fleetTick);
every(config.notify?.intervalMs ?? 15000, inboxTick);
every(config.notify?.intervalMs ?? 15000, readyTick);
every(config.poll.githubMs, githubTick);
every(config.poll.teamworkMs, teamworkTick);
every(RC.healthMs, recycleTick);
