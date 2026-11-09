#!/usr/bin/env node
// Live mode: V2 is the system of record; only this process writes the log. It polls, decides, messages and wakes seats, dispatches, marks PRs ready.
// Run: FACTORY_MODE=live node --env-file="$HOME/Code/repos/teamwork mini mcp/.env" bin/live.mjs
if (process.env.FACTORY_MODE !== 'live') { console.error('Refusing to run: set FACTORY_MODE=live.'); process.exit(2); }
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, derivedCtx } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';
import { createMcp } from '../mcp/server.mjs';
import { sandboxSeat } from '../core/sandbox-seat.mjs';
import { randomBytes } from 'node:crypto';
import { projectPrs, projectTasks, headCommands, ancestryWanted, healthCommands, recordPrKey, taskIdOf, projectCommands, auditMissed } from '../core/observe.mjs';
import { sourceCommands, sourceIndex } from '../core/correlate.mjs';
import { parseAcs } from '../core/derive.mjs';
import { inboxCommands } from '../core/inbox.mjs';
import { wakePlan } from '../core/wake.mjs';
import { autoDispatchPlan } from '../core/dispatch.mjs';
import { mergeCloses, holdReleases } from '../core/units.mjs';
import { TERMINAL, trackOf, stranded, observeHealth, skipNotes } from '../core/work.mjs';
import { readPrLines, readPrHealth, readPrs, readMainGreen, readCompare } from '../sources/github.mjs';
import { readTasks, readTopParents, readTaskFeedback } from '../sources/teamwork.mjs';
import { list as readFleet } from '../fleet/herdr.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogWake } from '../wake/log.mjs';
import { autoReadyTick } from '../effects/pr-ready.mjs';
import { planRecycles } from '../core/recycle.mjs';
import { gh as liveGh } from '../effects/github.mjs';
import { syncStandards } from '../hosts/standards.mjs';

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
  const plan = autoDispatchPlan(views, { supervisors: config.routing.supervisors, exclude: config.autoDispatch.exclude || [], drain }, { terminals });
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
  const workers = Object.fromEntries(Object.entries(config.routing.supervisors).filter(([, s]) => s.worker).map(([sup, s]) => [s.worker, sup]));
  const developer = Object.entries(config.roles || {}).find(([, r]) => r === 'board-developer')?.[0];
  const hostHowTo = Object.fromEntries(Object.entries(config.routing.supervisors).filter(([, s]) => s.howTo).map(([l, s]) => [l, s.howTo]));
  const plan = inboxCommands(store.state, { supervisors, seats, workers, hostHowTo, developer, developerSince: '2026-11-05T22:40:00.000Z', now: now(), workerSilentSince: '2026-11-06T17:45:00.000Z', workerSilentMs: config.notify?.workerSilentMs, router: config.routing.questionsRouter, cutoff: since, answersSince: config.notify?.answersSince || since, checkIn, triage, quietMs: config.notify?.quietWorkerMs },
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
const readyTick = () => autoReadyTick(store, gh, { standing: config.prReady?.enabled ? config.prReady.standing : null, isMutation: w => trackOf(w, config) === 'excluded', now, log: once });

// A stranded record (fixes/review with nothing live or pending) gets one heal after a grace period, so a seat mid-way
// through recording a step isn't overtaken (W-208 follow-up).
const strandedSince = {};
function healTick() {
  const t = Date.now();
  for (const w of Object.values(store.state.work)) {
    // Only open PRs on a stream: a closed PR's record is the merge/close path's, a trusted review is Alex's to rerun.
    if (!stranded(w, new Date(t).toISOString()) || trackOf(w, config) !== 'stream' || openPrs.get(w.links?.pr)?.state !== 'OPEN'
      || derivedCtx(store.state, w.id).openQuestions) { delete strandedSince[w.id]; continue; } // an open question: it waits on the answer
    strandedSince[w.id] ??= t;
    if (t - strandedSince[w.id] < (config.notify?.strandedGraceMs ?? 600000)) continue;
    apply([{ kind: 'event', target: w.id, payload: { type: 'heal', isDraft: openPrs.get(w.links?.pr)?.isDraft ?? null } }], 'board (heal)');
    log(`healed ${w.id} (${w.phase})`); delete strandedSince[w.id];
  }
}

// Conversation comments count from here (W-219): 11-05 catches #8577's codex finding without reopening older threads.
const COMMENTS_FROM = '2026-11-05T00:00:00.000Z';
let lastAudit = 0;
async function githubTick() {
  try {
    const owner = config.githubOwner, s = store.state;
    const tracked = [...new Set(Object.values(s.work).filter(w => !TERMINAL.includes(w.phase)).map(w => recordPrKey(w, owner)).filter(Boolean))];
    const { lines, own } = await readPrLines({ owner, tracked });
    const { prs, heads } = projectPrs(lines, own);
    const health = await readPrHealth([...own], owner, undefined, config.githubLogin, COMMENTS_FROM);
    const mainGreen = await readMainGreen([...new Set([...own].map(k => k.split(':')[0]))], owner).catch(e => { once(`main CI read: ${e.message}`); return new Map(); });
    // Ancestry is read here and logged on the row, so a replay never asks GitHub; a failed read retries next tick.
    const ancestry = new Map();
    for (const a of ancestryWanted(s, heads, owner)) try { ancestry.set(a.id, { base: a.base, status: await readCompare(owner, a.repo, a.base, a.head) }); } catch (e) { once(`compare ${a.id}: ${e.message}`); }
    apply([...headCommands(s, heads, { owner, now: now(), ancestry }), ...healthCommands(s, health, { owner, now: now(), exclude: config.autoDispatch?.exclude, mainGreen })], 'github');
    apply(sourceCommands(store.state, prs, 'pr', parseAcs, { exclude: config.autoDispatch?.exclude }), 'poller');
    // Hourly audit: anything the read saw that no record holds is a gap in the factory, so the board developer hears of it.
    if (Date.now() - lastAudit >= 3600000) {
      lastAudit = Date.now();
      const dev = Object.entries(config.roles || {}).find(([, r]) => r === 'board-developer')?.[0];
      const told = new Set(Object.values(store.state.messages).map(m => m.about?.missed).filter(Boolean));
      const missed = auditMissed(store.state, own, health, { owner, exclude: config.autoDispatch?.exclude, prs }).filter(m => !told.has(`${m.key}/${m.id}`));
      log(`audit: ${missed.length} missed`);
      for (const m of missed) if (dev) apply([{ kind: 'message', payload: { to: dev, about: { missed: `${m.key}/${m.id}` }, text: `[software factory, automated, not Alex] Audit: ${m.id === 'pr' ? `own PR ${m.key} has no live record` : `${m.key} feedback from ${m.by} was read but no record holds it: ${m.url}`}. Find why the factory missed it, fix that red-first, then make sure the item reaches its owner.` } }], 'board (audit)');
    }
    // PR states for the page and merge close: every PR a live record links.
    const links = [...new Set([...Object.values(store.state.work).filter(w => !TERMINAL.includes(w.phase)).map(w => w.links?.pr).filter(Boolean), ...holdReleases(store.state.work, owner).urls])];
    openPrs = new Map((await readPrs(links)).map(p => [p.url, p]));
    healTick();
    try { const n = syncStandards(); if (n.length) log(`standards mirrored: ${n.join(', ')}`); } catch (e) { log(`standards: ${e.message}`); }
    apply(skipNotes(store.state.work, config), 'board (skip)');
    await mergeTick();
    holdTick();
    await alexReviewTick();
  } catch (e) { log(`github: ${e.message}`); }
}

// A record whose PR merged (or a task whose every PR merged) closes as merged, re-verified on a fresh read. Teamwork stays human.
async function mergeTick() {
  if (!config.mergeClose?.enabled) return;
  const s = store.state, bySource = Object.fromEntries(sourceIndex(s));
  for (const c of mergeCloses(s.work, bySource, { prState: u => openPrs.get(u)?.state || null, openQuestions: id => derivedCtx(s, id).openQuestions, track: w => trackOf(w, config) })) {
    if (c.raise) {
      if (!Object.values(s.messages).some(m => m.about?.mergedPartial === c.id))
        apply([{ kind: 'message', payload: { to: 'local-head', work: c.id, about: { mergedPartial: c.id }, text: `[software factory] ${c.id}'s PR ${c.prs.join(', ')} merged, but the record covers work beyond it (coverage ${s.work[c.id].coverage?.state}), so it stays open. Ask Alex whether it's done.` } }], 'board');
      continue;
    }
    const prs = await readPrs(c.prs);
    if (prs.length !== c.prs.length || prs.some(p => p.state !== 'MERGED')) continue;
    const open = Object.entries(s.questions).filter(([, q]) => q.status === 'open' && q.work === c.id).map(([id]) => id);
    apply([{ kind: 'event', target: c.id, payload: { type: 'merged', prs, ...(c.outstanding.length && { outstanding: c.outstanding }) } },
      ...open.map(id => ({ kind: 'question_close', target: id, payload: { note: `${c.id}'s PR merged, which settles it` } }))], 'poller (merged)');
  }
}

// A record held until a PR merges (W-292) is released on the merge, and the board lead re-triages it.
function holdTick() {
  const lead = Object.entries(config.roles || {}).find(([, r]) => r === 'board-lead')?.[0];
  for (const { id, pr } of holdReleases(store.state.work, config.githubOwner, u => openPrs.get(u)?.state || null).released)
    apply([{ kind: 'event', target: id, payload: { type: 'hold_released', pr } },
      ...(lead ? [{ kind: 'message', payload: { to: lead, work: id, text: `[software factory, automated, not Alex] ${id}: ${pr} merged, so its hold is released. Re-triage it.` } }] : [])], 'poller (hold)');
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
  // Comments on a record's Teamwork task are feedback like a PR's. ponytail: records with no head yet aren't read.
  try {
    const live = Object.values(store.state.work).filter(w => !TERMINAL.includes(w.phase) && w.head && taskIdOf(w));
    const said = await readTaskFeedback([...new Set(live.map(taskIdOf))], COMMENTS_FROM);
    apply(live.filter(w => said.get(taskIdOf(w))?.length).flatMap(w => {
      const payload = { head: w.head, conflict: false, failing: [], comments: said.get(taskIdOf(w)) };
      return observeHealth(w, payload, { now: now(), by: 'teamwork' }) === w ? [] : [{ kind: 'observe_health', target: w.id, payload, ctx: { now: now(), by: 'teamwork' } }];
    }), 'teamwork');
  } catch (e) { log(`task comments: ${e.message}`); }
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

http.createServer(createApi({ store, config, gh: DRY ? null : liveGh, readPr: async url => (await readPrs([url]))[0] || null,
  observed: () => ({ units: fleet?.units || [], prs: openPrs, idleSince: watches.idleQueues || {}, graceMs: config.notify?.idleQueueGraceMs ?? 300000, queue: lastPlan, drain, health }) }))
  .listen(PORT, '127.0.0.1', () => log(`API and page on http://127.0.0.1:${PORT}`));

// The sandbox port (sbx workers on the board): MCP over HTTP only. The sandbox network policy allows this port and never
// PORT, so a sandbox can't reach the seat-trusting API; here the seat comes only from the sandbox's factory-minted token.
const SANDBOX_PORT = Number(process.env.FACTORY_SANDBOX_PORT || config.sandboxPort || 4849);
const SECRET_FILE = join(dirname(DB), 'sandbox-secret');
if (!existsSync(SECRET_FILE)) writeFileSync(SECRET_FILE, randomBytes(32).toString('hex'), { mode: 0o600 });
const SANDBOX_SECRET = readFileSync(SECRET_FILE, 'utf8').trim();
const workersOf = () => { try { return JSON.parse(readFileSync(join(dirname(DB), 'sandboxes.json'), 'utf8')); } catch { return {}; } };
const local = (seat, path, init = {}) => fetch(`http://127.0.0.1:${PORT}${path}`, { ...init, headers: { ...init.headers, 'x-seat': seat, 'x-factory': '1' } }).then(r => r.json());
const mcpApi = { get: (path, seat) => local(seat, path), post: (action, args, seat) => local(seat, '/api/actions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, args }) }) };
http.createServer(async (req, res) => {
  // No OAuth here: a 404 on discovery (/.well-known/...) tells an MCP client the server needs none.
  if (req.method !== 'POST' || !req.url.startsWith('/mcp')) { res.writeHead(req.url.startsWith('/mcp') ? 405 : 404).end(); return; }
  let body = ''; for await (const c of req) body += c;
  const seat = sandboxSeat(req.headers, SANDBOX_SECRET, workersOf()) || `unverified sandbox ${req.headers['x-sandbox'] || '?'}`;
  try {
    const out = await createMcp({ config, seatOf: async () => seat, api: mcpApi })(JSON.parse(body));
    if (out == null) { res.writeHead(202).end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
  } catch (e) { res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: e.message } })); }
}).listen(SANDBOX_PORT, '127.0.0.1', () => log(`sandbox MCP on http://127.0.0.1:${SANDBOX_PORT}/mcp`));

// Read each worker's disk, drain full ones, and cycle a drained worker once it is between tasks.
async function recycleTick() {
  if (!host || !fleet) return;
  for (const u of fleet.units.filter(u => supervisors.includes(u.supervisor?.label) && (u.worker?.sandbox || RC.host !== 'sbx'))) {
    try { health[u.id] = await host.health(u.worker); } catch (e) { once(`health ${u.worker?.label}: ${e.message}`); }
  }
  // When each worker's agent session started, read inside its sandbox with the disk check.
  const sessions = Object.fromEntries(Object.entries(health).filter(([, h]) => h?.agentSince).map(([k, h]) => [k, h.agentSince]));
  const plan = planRecycles({ units: fleet.units, health, works: store.state.work, threshold: RC.threshold, recycling, supervisors, sessions, restartStale: !!RC.restartStale });
  drain = plan.drain;
  for (const d of plan.due) {
    const tell = (to, about, text) => apply([{ kind: 'message', payload: { to, about, text: `[software factory] ${text}` } }], 'board');
    if (d.restart) {
      if (DRY) { once(`dry run: would restart ${d.worker.label}`); continue; }
      const r = await host.restart(d.worker).catch(e => ({ ok: false, detail: e.message }));
      log(`restart ${d.worker.label}: ${r.ok ? 'done' : 'FAILED'}: ${r.detail}`);
      if (r.ok) { delete health[d.unit]; tell(d.to, { restarted: `${d.worker.label}/${now()}`, fyi: true }, `${d.worker.label} was restarted between jobs (a fresh session in the same sandbox: repo and disk kept, context gone). Brief it cold. If its pane parks on a startup dialog, send it to local-head.`); }
      else tell(config.boardLead?.seat || 'board lead', { restartFailed: `${d.worker.label}/${now()}` }, `Restarting ${d.worker.label} between jobs failed: ${r.detail}. File it as a factory record if it repeats.`);
      continue;
    }
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
