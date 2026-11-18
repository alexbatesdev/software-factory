#!/usr/bin/env node
// Live mode: V2 is the system of record; only this process writes the log. It polls, decides, messages and wakes seats, dispatches, marks PRs ready.
// Run: FACTORY_MODE=live node --env-file="$HOME/Code/repos/teamwork mini mcp/.env" bin/live.mjs
if (process.env.FACTORY_MODE !== 'live') { console.error('Refusing to run: set FACTORY_MODE=live.'); process.exit(2); }
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, derivedCtx, supportOf, prGateView, skippedIds } from '../core/store.mjs';
import { createApi } from '../core/api.mjs';
import { createMcp } from '../mcp/server.mjs';
import { sandboxSeat } from '../core/sandbox-seat.mjs';
import { randomBytes } from 'node:crypto';
import { projectPrs, projectTasks, headCommands, ancestryWanted, healthCommands, recordPrKey, taskIdOf, projectCommands, auditMissed } from '../core/observe.mjs';
import { sourceCommands, sourceIndex } from '../core/correlate.mjs';
import { parseAcs } from '../core/derive.mjs';
import { inboxCommands } from '../core/inbox.mjs';
import { wakePlan } from '../core/wake.mjs';
import { autoDispatchPlan, busyStreams } from '../core/dispatch.mjs';
import { scoutPlan } from '../core/scout.mjs';
import { mergeCloses, holdReleases, questionHolds, watchedPrs, reviewsDue, contradictions } from '../core/units.mjs';
import { TERMINAL, trackOf, stranded, observeHealth, skipNotes, REVIEW_CAP_FROM } from '../core/work.mjs';
import { readPrLines, readPrHealth, readPrs, readMain, readCompare, readOpenPrFiles, readTeamPrs } from '../sources/github.mjs';
import { duplicateCommands, unbuiltProposals, repoOf } from '../core/duplicates.mjs';
import { readTasks, readTopParents, readTaskFeedback, createTask, getTask, findTask, readTree } from '../sources/teamwork.mjs';
import { readPlanning } from '../sources/planning.mjs';
import { circleReady, readJobFailures } from '../sources/circleci.mjs';
import { compareCheck, compareWarnings, withStaleness } from '../core/ci-compare.mjs';
import { runBrakeman, AUDIT_CHECK } from '../sources/audit.mjs';
import { buildProjects, projectNote, projectRoots, resolveSpec, specFollowUps, specView, triageCreates } from '../core/projects.mjs';
import { list as readFleet, herdrRaw } from '../fleet/herdr.mjs';
import { seatsOf, planSeatRestarts, stopSeat, startSeat, seatRenames } from '../fleet/factory.mjs';
import { toolsFor } from '../mcp/server.mjs';
import { roleOf } from '../core/api.mjs';
import { LEAD_ROLE, DEVELOPER_ROLE } from '../core/capabilities.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogWake } from '../wake/log.mjs';
import { syncResolvedThreads } from '../effects/threads.mjs';
import { autoReadyTick } from '../effects/pr-ready.mjs';
import { planRecycles, releaseFinished, blockKey, diskNote } from '../core/recycle.mjs';
import { retainArtifacts, unretainedStreams } from '../core/artifacts.mjs';
import { readReport, readUsage } from '../hosts/sbx.mjs';
import { readFile } from 'node:fs/promises';
import { backup, backupPlan, verifyBackup } from './backup.mjs';
import { createRuntimeLog } from '../core/runtime-log.mjs';
import { captureManifests, manifestsDue } from '../core/manifest.mjs';
import { outcomes, outcomesMarkdown, codexSinceOf } from '../core/outcomes.mjs';
import { usageDue, costOf, sumTokens } from '../core/usage.mjs';
import { readHostUsage } from '../hosts/usage.mjs';
import { checkConfig } from '../core/preflight.mjs';
import { ROLES } from '../core/capabilities.mjs';
import { gh as liveGh, reviewState, requestReview } from '../effects/github.mjs';
import { rerequestPlan } from '../core/rerequest.mjs';
import { syncStandards } from '../hosts/standards.mjs';
import { agentOf } from '../fleet/factory.mjs';

// Dry run (FACTORY_DRY=1, FACTORY_DB=<a copy of data/factory.db>): reads are real, nothing is typed, marked or moved.
const DRY = process.env.FACTORY_DRY === '1';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const supervisors = Object.keys(config.routing.supervisors);
const DB = process.env.FACTORY_DB || join(ROOT, 'data/factory.db');
const ARTIFACTS = join(dirname(DB), 'artifacts'), CODE = join(homedir(), 'Code') + '/';
const LOG = join(dirname(DB), 'live.log');
const run = promisify(execFile);
const gh = DRY ? { ...liveGh, ready: async url => { throw new Error(`dry run: would mark ${url} ready`); } } : liveGh;
const wake = DRY ? createLogWake(join(dirname(DB), 'would-wake.jsonl')) : (await import('../wake/herdr.mjs')).wake;
const PORT = Number(process.env.FACTORY_PORT || 4848);
const now = () => new Date().toISOString();
const runtime = createRuntimeLog(join(dirname(DB), 'runtime.jsonl'), { now, warn: m => log(m) });
const log = (...a) => { console.log(now().slice(11, 19), ...a); appendFileSync(LOG, `${now()} ${a.join(' ')}\n`); runtime.line(a.join(' ')); };
const by = name => ({ now: now(), by: name });
// One command at a time: a refused observation is logged and the rest still land.
const apply = (cmds, who) => { for (const c of cmds) try { store.append(c, by(who)); } catch (e) { log(`refused ${c.kind} ${c.target || ''}: ${e.message}`); } };

mkdirSync(dirname(DB), { recursive: true });
// Config preflight: problems are said at start, and to the factory lead; the factory still starts.
const CONFIG_PROBLEMS = checkConfig(config, { roles: ROLES, exists: existsSync, home: homedir() });
const store = openStore(DB, { supervisors });
// What the factory leaves alone this tick: the exclude list, plus support records while Alex has support paused.
// The factory lead's seat: config.boardLead.seat, else the seat config.roles gives the lead role.
const LEAD = config.boardLead?.seat || Object.entries(config.roles || {}).find(([, r]) => r === LEAD_ROLE)?.[0] || 'factory lead';
const skipped = () => ({ exclude: skippedIds(store.state, config) });
log(`${DRY ? 'DRY RUN' : 'live'}: ${DB} at seq ${store.state.seq}`);
for (const p of CONFIG_PROBLEMS) log(`config preflight: ${p}`);
if (CONFIG_PROBLEMS.length && !DRY) { const key = createHash('sha256').update(CONFIG_PROBLEMS.join('\n')).digest('hex').slice(0, 12);
  if (!Object.values(store.state.messages).some(m => m.about?.configPreflight === key)) store.append({ kind: 'message', payload: { to: LEAD, about: { configPreflight: key }, text: `[software factory] config.json preflight found ${CONFIG_PROBLEMS.length} problem(s): ${CONFIG_PROBLEMS.join('; ')}. File a factory record for the factory developer.` } }, by('factory')); }
// Intake triage covers records created since the final import, the moment V2 became the system of record.
const LIVE_SINCE = store.rows()[0]?.at || now();

let fleet = null, watches = {}, woken = {}, openPrs = new Map(), prsReadAt = null, lastPlan = [], ownPrs = new Map(), heldRequests = new Set(), projectNotes = {}, lastBusy = [];
// Projects (Alex, 11-16): the planning repo and each active project's Teamwork tree, read every 30 min and kept for a restart.
const PROJECTS_CACHE = join(ROOT, 'data/projects-cache.json');
// What spec resolution reads: the last planning read (null until there is one) and the project trees.
const specRead = () => ({ planning: projectsRead.readAt ? projectsRead.planning : null, trees: projectsRead.trees });
let projectsRead = (() => { try { return JSON.parse(readFileSync(PROJECTS_CACHE, 'utf8')); } catch { return { planning: [], trees: {}, readAt: null }; } })();
// Worker hosts (Alex, 11-04): disk readings, cycles under way or failed, and the streams draining for one.
const RC = { enabled: false, threshold: 0.75, hardStop: 0.9, host: 'sbx', healthMs: 300000, ...config.recycle };
const diskLogged = {};
let hardStops = new Map();
const host = RC.enabled ? await import(`../hosts/${RC.host}.mjs`) : null;
let health = {}, recycling = {}, drain = new Map(), drainRead = false, restartFailedAt = {};
// Each sbx worker's model and effort (deep-model, Alex 11-11): what it was last started with, and restarts a record asked for.
const TUNED = join(dirname(DB), 'worker-tuning.json');
const tuned = (() => { try { return JSON.parse(readFileSync(TUNED, 'utf8')); } catch { return {}; } })();
const retune = new Map();
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
  const prs = { owner: config.githubOwner, prState: u => openPrs.get(u)?.state || null };
  // Projects phase B: a project's task carries whether its project is ready for it.
  const built = buildProjects({ ...projectsRead, works: s.work, prs: ownPrs, me: config.githubLogin }).projects;
  const gates = new Map(built.flatMap(p => p.leaves.filter(l => l.work).map(l => [l.work, { slug: p.slug, ...l.gate }])));
  // Phase C: a project task's notices point its supervisor at the plan the worker follows and the task's test plan.
  projectNotes = Object.fromEntries(built.flatMap(p => p.leaves.filter(l => l.work && p.factoryPlan).map(l => [l.work, projectNote(p, l, resolveSpec(s.work[l.work], specRead()))])));
  const views = Object.values(s.work).map(w => ({ ...prGateView(s, w), ...derivedCtx(s, w.id, prs), ...(gates.has(w.id) ? { projectGate: gates.get(w.id) } : {}) }));
  const terminals = [...(fleet?.others || []), ...(fleet?.units || []).flatMap(u => [u.supervisor, u.worker].filter(Boolean))].filter(a => a.workspace === 'Terminals').map(a => a.label);
  const toldRequests = new Set(Object.values(s.messages).flatMap(m => [m.about?.requests].flat().filter(Boolean)));
  const plan = autoDispatchPlan(views, { supervisors: config.routing.supervisors, ...skipped(), drain, prApproval: config.prApproval, running: tuned, toldRequests, now: now(), agentFallbackMs: config.autoDispatch?.agentFallbackMs }, { terminals });
  heldRequests = new Set(plan.filter(p => !p.action && p.request).map(p => p.request));
  // One factory queue (W-505): a waiting round moves to the free stream; its owner follows when it was the old stream's.
  for (const p of plan.filter(p => p.action === 'route')) {
    const w = s.work[p.id], old = config.routing.supervisors[w.stream];
    const owner = [w.stream, old?.worker].includes(w.owner) ? { owner: p.to } : {};
    try { store.appendAll([{ kind: 'update', target: p.id, payload: { stream: p.to, ...owner } }, { kind: 'event', target: p.id, payload: { type: 'note', text: `Factory queue: ${p.request} goes to ${p.to}: ${p.reason}.` } }], by('factory (auto-dispatch)')); log(`route ${p.request} -> ${p.to}`); }
    catch (e) { log(`route ${p.request} refused: ${e.message}`); }
  }
  lastPlan = plan;
  lastBusy = [...busyStreams(views, { supervisors: config.routing.supervisors, drain, toldRequests })];
  for (const p of plan.filter(p => p.action === 'retune')) if (!retune.has(p.to)) { retune.set(p.to, p); log(`retune ${p.to} for ${p.id}: ${p.reason}`); }
  for (const p of plan.filter(p => p.action === 'resume')) {
    const key = `${p.id}/${p.assignmentId}/v${p.version}`;
    if (Object.values(store.state.messages).some(m => m.about?.resume === key)) continue;
    apply([{ kind: 'message', payload: { to: p.to, work: p.id, about: { resume: key }, text: `[software factory] Resume ${p.id} ${p.assignmentId}: ${p.reason}. Brief a fresh worker from its handoff, then progress ${p.assignmentId} --stage started.` } },
      { kind: 'event', target: p.id, payload: { type: 'note', text: `Resume sent to ${p.to}: ${p.reason}.` } }], 'factory (auto-dispatch)');
    log(`resume ${p.id} ${p.assignmentId} -> ${p.to}`);
  }
  for (const p of plan.filter(p => p.action && !['resume', 'route', 'deliver'].includes(p.action))) {
    const w = s.work[p.id], who = 'factory (auto-dispatch)';
    const cmds = [
      ...(p.owner ? [{ kind: 'update', target: p.id, payload: { stream: p.owner, ...(w.owner ? {} : { owner: p.owner }) } }] : []),
      { kind: 'event', target: p.id, payload: p.action === 'queue' ? { type: 'transition', to: 'queued' } : { type: 'request', request: 'dispatch' } },
      { kind: 'event', target: p.id, payload: { type: 'note', text: `Auto-dispatched to ${p.to}: ${p.reason}.` } },
    ];
    try { store.appendAll(cmds, by(who)); log(`dispatch ${p.id} -> ${p.to}`); } catch (e) { log(`dispatch ${p.id} refused: ${e.message}`); }
  }
  // Nothing to dispatch and a stream free: send it scouting Sentry (Alex, 11-09). Next tick dispatches the record.
  const scout = scoutPlan(views, plan, { supervisors: config.routing.supervisors, drain, scout: config.scout }, now());
  if (!scout.create) once(`scout: ${scout.reason}`);
  else try { const { id } = store.append({ kind: 'create', payload: scout.create }, by('factory (scout)')); log(`scout ${id} for ${scout.to}`); } catch (e) { log(`scout refused: ${e.message}`); }
}

async function inboxTick() {
  ingestInbox();
  autoDispatchTick();
  const seats = [...supervisors, config.routing.questionsRouter, ...Object.keys(config.roles || {}), ...(config.factory?.seats || []).map(s => s.label)];
  const since = store.state.legacy.notifier?.activatedAt;
  const checkIn = config.boardLead?.checkIn !== false ? { seat: LEAD, now: now() } : null;
  const triage = { seat: LEAD, since: LIVE_SINCE };
  const workers = Object.fromEntries(Object.entries(config.routing.supervisors).filter(([, s]) => s.worker).map(([sup, s]) => [s.worker, sup]));
  const developer = Object.entries(config.roles || {}).find(([, r]) => r === DEVELOPER_ROLE)?.[0];
  const hostHowTo = Object.fromEntries(Object.entries(config.routing.supervisors).filter(([, s]) => s.howTo).map(([l, s]) => [l, s.howTo]));
  const plan = inboxCommands(store.state, { ...skipped(), supervisors, seats, workers, hostHowTo, developer, developerSince: '2026-11-05T22:40:00.000Z', now: now(), workerSilentSince: '2026-11-06T17:45:00.000Z', workerSilentMs: config.notify?.workerSilentMs, router: config.routing.questionsRouter, cutoff: since, answersSince: config.notify?.answersSince || since, checkIn, triage, quietMs: config.notify?.quietWorkerMs, heldRequests, projectNotes, drainLiftSince: '2026-11-18T00:10:00.000Z' },
    fleet && { units: fleet.units, others: fleet.others, now: Date.now(), watches, quiet, drain, drainRead, health, stop: hardStops });
  watches = plan.watches;
  for (const c of plan.cmds) { store.append(c, by('factory')); log(`message -> ${c.payload.to}: ${JSON.stringify(c.payload.about)}`); }
  const sessions = Object.fromEntries([...(fleet?.others || []), ...(fleet?.units || []).flatMap(u => [u.supervisor, u.worker].filter(Boolean))].map(a => [a.label, a.session]));
  for (const w of wakePlan(store.state, woken, Date.now(), config.notify?.reminderMs, sessions)) {
    const r = await wake({ ...w, agent: agentOf(config, w.seat) }).catch(e => ({ ok: false, reason: e.message }));
    if (r.ok) { woken[w.seat] = { at: Date.now(), ids: w.ids, reminded: w.reminder, session: r.session }; log(`woke ${w.seat}${w.reminder ? ' (reminder)' : ''}`); }
  }
}

// Marking PRs ready waits on GitHub; on its own loop so a slow GitHub never holds up messages and wakes (W-199).
const readyTick = () => autoReadyTick(store, gh, { standing: config.prReady?.enabled ? config.prReady.standing : null, isMutation: w => trackOf(w, skipped()) === 'excluded', now, log: once });

// A stranded record (fixes/review with nothing live or pending) gets one heal after a grace period, so a seat mid-way
// through recording a step isn't overtaken (W-208 follow-up).
const strandedSince = {};
function healTick() {
  const t = Date.now();
  for (const w of Object.values(store.state.work)) {
    // Only open PRs on a stream: a closed PR's record is the merge/close path's, a trusted review is Alex's to rerun.
    if (!stranded(w, new Date(t).toISOString()) || trackOf(w, skipped()) !== 'stream' || openPrs.get(w.links?.pr)?.state !== 'OPEN'
      || derivedCtx(store.state, w.id).openQuestions) { delete strandedSince[w.id]; continue; } // an open question: it waits on the answer
    strandedSince[w.id] ??= Math.min(t, Date.parse(w.updatedAt) || t); // its last change, so a server restart doesn't restart the grace (W-511)
    if (t - strandedSince[w.id] < (config.notify?.strandedGraceMs ?? 600000)) continue;
    apply([{ kind: 'event', target: w.id, payload: { type: 'heal', isDraft: openPrs.get(w.links?.pr)?.isDraft ?? null } }], 'factory (heal)');
    log(`healed ${w.id} (${w.phase})`); delete strandedSince[w.id];
  }
}

/** task id → every task below it, from the project trees (a PR may link a subtask of a task it owns, W-519). */
function subtasksOf(trees = {}) {
  const kids = new Map(); for (const nodes of Object.values(trees)) for (const n of nodes) kids.set(n.parent, [...(kids.get(n.parent) || []), n.id]);
  const below = id => (kids.get(id) || []).flatMap(k => [k, ...below(k)]);
  return new Map([...kids.keys()].map(id => [id, below(id)]));
}

async function projectsTick() {
  if (DRY) return;
  const planning = await readPlanning(), trees = { ...projectsRead.trees };
  for (const p of planning.filter(p => !['Archived', 'Complete'].includes(p.readme.status))) for (const root of projectRoots(p))
    try { trees[root] = await readTree(root); } catch (e) { once(`project tree ${p.slug}: ${e.message}`); }
  // Phase D: everyone's open PRs in the team repos, read-only, so a teammate's PR shows on its project task.
  const teamPrs = await readTeamPrs(config.projects?.teamRepos || ['built-rails'], config.githubOwner).catch(e => { once(`team PRs: ${e.message}`); return projectsRead.teamPrs || []; });
  projectsRead = { planning, trees, teamPrs, readAt: now() };
  // Phase C: a planning job for each project the factory is about to work that has no plan on main yet.
  if (config.projects?.planningJobs) for (const c of triageCreates(buildProjects({ ...projectsRead, works: store.state.work, prs: ownPrs, me: config.githubLogin }).projects, store.state.work, config.projects))
    try { const { id } = store.append({ kind: 'create', payload: c }, by('factory (projects)')); log(`planning job ${id}: ${c.title}`); } catch (e) { log(`planning job refused: ${e.message}`); }
  writeFileSync(PROJECTS_CACHE, JSON.stringify(projectsRead));
  log(`projects: ${planning.length} read, ${Object.keys(trees).length} trees`);
  // Phase 2: a spec edit during a job on an enabled project becomes its follow-up; the job's brief and pin stand.
  // One record's follow-up lands whole or not at all: its message is what marks it told.
  const follow = specFollowUps(store.state, specRead(), { slugs: config.projects?.specFollowUps || [] }), byRecord = new Map();
  for (const c of follow) { const id = c.target || c.payload.work; byRecord.set(id, [...(byRecord.get(id) || []), c]); }
  for (const [id, cmds] of byRecord)
    try { store.appendAll(cmds, by('factory (spec)')); log(`spec follow-up ${cmds.at(-1).payload.about.specDelta}`); } catch (e) { log(`spec follow-up ${id} refused: ${e.message}`); }
}

// W-501: a PR's CircleCI check that fails on main by name is compared test by test with main's latest finished run.
// A finished run never changes, so a PR head's jobs are read once; main's are re-read every 10 minutes.
const ciRuns = new Map();
async function ciRun(key, read, ttl = Infinity) {
  const hit = ciRuns.get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.jobs;
  const jobs = await read();
  if (jobs) ciRuns.set(key, { jobs, at: Date.now() });
  return jobs;
}
// On-demand Brakeman (Alex 11-16): only when a built-rails PR into main fails Audit and no open record tracks Audit as red
// on main, Brakeman runs on the host for main's head and the PR's head (one run at a time, cached per commit) and the
// warnings are compared. Never on a timer, never in a sandbox.
const audits = new Map();
let auditChain = Promise.resolve();
function audited(sha) {
  if (audits.has(sha)) return audits.get(sha).result;
  const entry = { result: null }; audits.set(sha, entry);
  auditChain = auditChain.then(() => runBrakeman({ checkout: join(homedir(), 'Code/repos/built-rails-a'), sha, cacheDir: join(ROOT, 'data/audit'), log })
    .then(r => { entry.result = r; log(`audit ${sha.slice(0, 7)}: ${r.warnings.length} Brakeman warning(s) in ${Math.round(r.durationMs / 1000)}s`); }, e => { entry.result = { error: e.message }; log(`audit ${sha.slice(0, 7)} failed: ${e.message}`); }));
  return null;
}
async function compareAudit(health, ciCompare) {
  if (config.audit?.auto === false || DRY) return;
  const key = `ci:built-rails:${AUDIT_CHECK}`;
  if (Object.values(store.state.work).some(w => !TERMINAL.includes(w.phase) && [w.source?.key, ...(w.aliases || [])].includes(key))) return;
  const wanting = [...health].filter(([k, h]) => k.startsWith('built-rails:') && h.base === 'main' && h.failing.includes(AUDIT_CHECK));
  if (!wanting.length) return;
  const git = await mainGit('built-rails'), main = git && (await git('rev-parse', 'origin/main')).stdout.trim();
  const onMain = main && audited(main);
  for (const [k, h] of wanting) {
    const set = c => { if (!ciCompare.has(k)) ciCompare.set(k, {}); ciCompare.get(k)[AUDIT_CHECK] = c; };
    const pr = audited(h.head);
    if (pr?.error || onMain?.error) continue; // a run that failed decides nothing: the name match stands
    // Until both runs are in, the failure waits rather than opening a fixes round on a guess (W-520).
    if (!pr || !onMain) { set({ verdict: 'pending', prOnly: [], shared: [] }); continue; }
    let c = compareWarnings(pr.warnings, onMain.warnings);
    if (c.verdict === 'ours') {
      // Warnings gone from main may predate the branch: Brakeman where it left main tells "merge main" from "fix it".
      const base = (await git('merge-base', main, h.head).catch(() => null))?.stdout.trim(), atBase = base && audited(base);
      if (base && !atBase) { set({ verdict: 'pending', prOnly: [], shared: [] }); continue; }
      if (atBase && !atBase.error) c = compareWarnings(pr.warnings, onMain.warnings, atBase.warnings);
    }
    set(c);
  }
}

// The files a PR's branch changed and the files main changed since the branch point (W-532), per head and main commit.
const branchFileCache = new Map();
async function branchFiles(repo, head) {
  const git = await mainGit(repo);
  if (!git) return null;
  try {
    const main = (await git('rev-parse', 'origin/main')).stdout.trim(), key = `${repo}@${head}@${main}`;
    if (branchFileCache.has(key)) return branchFileCache.get(key);
    await git('cat-file', '-e', `${head}^{commit}`).catch(() => git('fetch', '-q', 'origin', head));
    const base = (await git('merge-base', main, head)).stdout.trim(), names = async (a, b) => (await git('diff', '--name-only', a, b)).stdout.split('\n').filter(Boolean);
    const files = { prFiles: await names(base, head), mainFiles: await names(base, main) };
    branchFileCache.set(key, files);
    return files;
  } catch (e) { once(`branch files ${repo}@${head.slice(0, 7)}: ${e.message}`); return null; }
}

async function compareCi(health, mainFailing, prs, owner) {
  const out = new Map();
  if (!circleReady()) return out;
  for (const [key, h] of health) {
    const [repo, n] = key.split(':'), slug = `gh/${owner}/${repo}`, branch = prs.get(`${repo}-${n}`)?.branch;
    const checks = h.failing.filter(f => f.startsWith('ci/circleci: ') && (mainFailing.get(repo) || []).includes(f));
    if (h.base !== 'main' || !branch || !checks.length) continue;
    try {
      const pr = await ciRun(`${slug}@${h.head}`, () => readJobFailures(slug, branch, h.head));
      const main = await ciRun(`${slug}@main`, () => readJobFailures(slug, 'main'), 600000) || new Map();
      if (!pr) continue;
      let cmp = Object.fromEntries(checks.map(f => [f, compareCheck(pr.get(f), main.get(f))]));
      // Failures main may have fixed since the branch point (W-532): the files each side changed decide it.
      if (Object.values(cmp).some(c => ['unknown', 'ours'].includes(c.verdict))) {
        const files = await branchFiles(repo, h.head);
        if (files) cmp = Object.fromEntries(Object.entries(cmp).map(([f, c]) => [f, withStaleness(c, pr.get(f), files)]));
      }
      out.set(key, cmp);
    } catch (e) { once(`circleci ${key}: ${e.message}`); }
  }
  return out;
}

// Conversation comments count from here (W-219): 11-05 catches #8577's codex finding without reopening older threads.
const COMMENTS_FROM = '2026-11-05T00:00:00.000Z';
let lastAudit = 0, contradictionsDue = false;
async function githubTick() {
  try {
    const owner = config.githubOwner, s = store.state;
    const tracked = [...new Set(Object.values(s.work).filter(w => !TERMINAL.includes(w.phase)).map(w => recordPrKey(w, owner)).filter(Boolean))];
    const { lines, own } = await readPrLines({ owner, tracked });
    const { prs, heads } = projectPrs(lines, own);
    ownPrs = prs;
    const health = await readPrHealth([...own], owner, undefined, config.githubLogin, COMMENTS_FROM);
    const main = await readMain([...new Set([...own].map(k => k.split(':')[0]))], owner).catch(e => { once(`main CI read: ${e.message}`); return new Map(); });
    const mainGreen = new Map([...main].map(([r, m]) => [r, m.green])), mainFailing = new Map([...main].map(([r, m]) => [r, m.failing])), mainPassing = new Map([...main].map(([r, m]) => [r, m.passing]));
    const ciCompare = await compareCi(health, mainFailing, prs, owner);
    await compareAudit(health, ciCompare);
    // Ancestry is read here and logged on the row, so a replay never asks GitHub; a failed read retries next tick.
    const ancestry = new Map();
    if (now() >= REVIEW_CAP_FROM) for (const a of ancestryWanted(s, heads, owner)) try { ancestry.set(a.id, { base: a.base, status: await readCompare(owner, a.repo, a.base, a.head) }); } catch (e) { once(`compare ${a.id}: ${e.message}`); }
    apply([...headCommands(s, heads, { owner, now: now(), standingWaiver: config.standingWaiver, ancestry }), ...healthCommands(s, health, { owner, now: now(), ...skipped(), mainGreen, mainFailing, mainPassing, ciCompare, subtasks: subtasksOf(projectsRead.trees), branches: new Map([...prs].map(([id, p]) => [id, p.branch])) })], 'github');
    apply(sourceCommands(store.state, prs, 'pr', parseAcs, skipped()), 'poller');
    // Hourly audit: anything the read saw that no record holds is a gap in the factory, so the factory developer hears of it.
    if (Date.now() - lastAudit >= 3600000) {
      lastAudit = Date.now();
      contradictionsDue = true;
      const dev = Object.entries(config.roles || {}).find(([, r]) => r === DEVELOPER_ROLE)?.[0];
      const told = new Set(Object.values(store.state.messages).map(m => m.about?.missed).filter(Boolean));
      const missed = auditMissed(store.state, own, health, { owner, ...skipped(), prs, now: now() }).filter(m => !told.has(`${m.key}/${m.id}`));
      log(`audit: ${missed.length} missed`);
      for (const m of missed) if (dev) apply([{ kind: 'message', payload: { to: dev, about: { missed: `${m.key}/${m.id}` }, text: `[software factory, automated, not Alex] Audit: ${m.id === 'pr' ? `own PR ${m.key} has no live record` : `${m.key} feedback from ${m.by} was read but no record holds it: ${m.url}`}. Find why the factory missed it, fix that red-first, then make sure the item reaches its owner.` } }], 'factory (audit)');
    }
    // PR states for the page and merge close: every PR a live record links.
    // Open thread requests' PRs too: a merge closes their record, and the request must still see it (dismissal).
    const links = [...new Set([...watchedPrs(store.state.work, Object.fromEntries(sourceIndex(store.state))), ...holdReleases(store.state.work, owner).urls,
      ...Object.values(store.state.threads).filter(t => ['requested', 'failed'].includes(t.status)).map(t => t.pr)])];
    openPrs = new Map((await readPrs(links)).map(p => [p.url, p]));
    prsReadAt = Date.now();
    reviewTick();
    healTick();
    try { const n = syncStandards(); if (n.length) log(`standards mirrored: ${n.join(', ')}`); } catch (e) { log(`standards: ${e.message}`); }
    apply(skipNotes(store.state.work, skipped()), 'factory (skip)');
    await mergeTick();
    holdTick();
    // After merge-close, so a merge it just closed is not reported. Once per (kind, record), to the factory lead (W-317).
    if (contradictionsDue) {
      contradictionsDue = false;
      const lead = LEAD, told = new Set(Object.values(store.state.messages).map(m => m.about?.contradiction).filter(Boolean));
      const found = contradictions(store.state, { prState: u => openPrs.get(u)?.state || null, now: now() }).filter(c => !told.has(`${c.kind}/${c.id}`));
      log(`audit: ${found.length} contradictions`);
      for (const c of found) apply([{ kind: 'message', payload: { to: lead, work: c.id, about: { contradiction: `${c.kind}/${c.id}` }, text: `[software factory, automated, not Alex] Contradiction on ${c.id} (${c.kind}): ${c.evidence}. Next: ${c.next}.` } }], 'factory (audit)');
    }
    await syncResolvedThreads(store, gh, now, { me: config.githubLogin, prState: u => openPrs.get(u)?.state || null });
    await alexReviewTick();
  } catch (e) { log(`github: ${e.message}`); }
}

// W-426 (Alex, 11-11): re-request a non-approving reviewer once their threads are resolved and the head moved, once
// per round. Off by default: with config.rerequest.enabled false it only logs who it would ask.
async function rerequestTick() {
  const s = store.state, urls = [...new Set(Object.values(s.work).filter(w => w.links?.pr && !TERMINAL.includes(w.phase) && trackOf(w, skipped()) !== 'excluded').map(w => w.links.pr))]
    .filter(u => openPrs.get(u)?.state === 'OPEN');
  // Its own loop, reading 8 PRs at a time, so 50-odd PR reads never hold up githubTick's ready marks and releases (W-428).
  const prs = [];
  for (let i = 0; i < urls.length; i += 8)
    for (const p of await Promise.all(urls.slice(i, i + 8).map(u => reviewState(u).catch(e => { once(`review state ${u}: ${e.message}`); return null; }))))
      if (p?.open && p.author === config.githubLogin) prs.push(p);
  for (const r of rerequestPlan(s.work, prs, { maxAgeMs: (config.rerequest?.maxAgeDays ?? 7) * 86400000 })) {
    if (!config.rerequest?.enabled || DRY) { once(`re-request (off): would re-request ${r.reviewer} on ${r.pr} (${r.work}, ${r.state} at ${r.reviewAt})`); continue; }
    const ok = await requestReview(r.pr, r.reviewer).catch(e => { log(`re-request ${r.reviewer} on ${r.pr}: ${e.message}`); return false; });
    if (ok) apply([{ kind: 'event', target: r.work, payload: { type: 'reviewer_rerequested', reviewer: r.reviewer, reviewAt: r.reviewAt, head: r.head, state: r.state } }], 'factory (re-request)');
    else once(`re-request ${r.reviewer} on ${r.pr}: GitHub doesn't show the request after the call`);
  }
}

// A record whose PR merged (or a task whose every PR merged) closes as merged, re-verified on a fresh read. Teamwork stays human.
async function mergeTick() {
  if (!config.mergeClose?.enabled) return;
  const s = store.state, bySource = Object.fromEntries(sourceIndex(s));
  for (const c of mergeCloses(s.work, bySource, { prState: u => openPrs.get(u)?.state || null, openQuestions: id => derivedCtx(s, id).openQuestions, track: w => trackOf(w, skipped()) })) {
    if (c.raise) {
      if (!Object.values(s.messages).some(m => m.about?.mergedPartial === c.id))
        apply([{ kind: 'message', payload: { to: 'local-head', work: c.id, about: { mergedPartial: c.id }, text: `[software factory] ${c.id}'s PR ${c.prs.join(', ')} merged, but the record covers work beyond it (coverage ${s.work[c.id].coverage?.state}), so it stays open. Ask Alex whether it's done.` } }], 'factory');
      continue;
    }
    const prs = await readPrs(c.prs);
    if (prs.length !== c.prs.length || prs.some(p => p.state !== 'MERGED')) continue;
    const open = Object.entries(s.questions).filter(([, q]) => q.status === 'open' && q.work === c.id).map(([id]) => id);
    apply([{ kind: 'event', target: c.id, payload: { type: 'merged', prs, ...(c.outstanding.length && { outstanding: c.outstanding }) } },
      ...open.map(id => ({ kind: 'question_close', target: id, payload: { note: `${c.id}'s PR merged, which settles it` } }))], 'poller (merged)');
  }
}

// A hold past its review date tells its reviewer once per date; the hold stays until someone triages it (W-317).
function reviewTick() {
  for (const d of reviewsDue(store.state.work, now())) {
    const key = `${d.id}/${d.by}`;
    if (Object.values(store.state.messages).some(m => m.about?.reviewDue === key)) continue;
    apply([{ kind: 'message', payload: { to: d.reviewer, work: d.id, about: { reviewDue: key }, text: `[software factory, automated, not Alex] ${d.id}'s hold was due for review on ${d.by}. Look again: re-triage it (ready, a new reviewBy, untilMerged/untilAnswered, deferredTo, or close). The board has not released it.` } }], 'factory (hold review)');
  }
}

// A record held until a PR merges (W-292) is released on the merge, and the factory lead re-triages it.
function holdTick() {
  const lead = Object.entries(config.roles || {}).find(([, r]) => r === LEAD_ROLE)?.[0];
  const { released, closed, waitsMerged, waitsClosed } = holdReleases(store.state.work, config.githubOwner, u => openPrs.get(u)?.state || null);
  // W-436: a record-level wait on a PR clears when it merges; its parker hears either way.
  for (const { id, pr, to } of waitsMerged)
    apply([{ kind: 'event', target: id, payload: { type: 'wait', clear: true, evidence: `${pr} merged (GitHub)` } },
      { kind: 'message', payload: { to: to || lead, work: id, text: `[software factory, automated, not Alex] ${id}: ${pr} merged, so its wait is cleared. Act on it now (close it, resume it, or re-triage).` } }], 'poller (hold)');
  for (const { id, pr, to } of waitsClosed) {
    const key = `${id}/${pr}/wait`;
    if (!Object.values(store.state.messages).some(m => m.about?.holdClosed === key))
      apply([{ kind: 'message', payload: { to: to || lead, work: id, about: { holdClosed: key }, text: `[software factory, automated, not Alex] ${id}: it waits on ${pr}, which closed without merging, so the wait will never clear. Re-point or close it.` } }], 'poller (hold)');
  }
  for (const { id, pr } of closed) {
    const key = `${id}/${pr}`;
    if (lead && !Object.values(store.state.messages).some(m => m.about?.holdClosed === key))
      apply([{ kind: 'message', payload: { to: lead, work: id, about: { holdClosed: key }, text: `[software factory, automated, not Alex] ${id}: ${pr} closed without merging, so its hold will never release; re-triage it.` } }], 'poller (hold)');
  }
  for (const { id, pr } of released)
    apply([{ kind: 'event', target: id, payload: { type: 'hold_released', pr } },
      ...(lead ? [{ kind: 'message', payload: { to: lead, work: id, text: `[software factory, automated, not Alex] ${id}: ${pr} merged, so its hold is released. Re-triage it.` } }] : [])], 'poller (hold)');
}

// A record held on a question is released when Alex answers it; one closed unanswered goes back to the factory lead.
function questionHoldTick() {
  const lead = Object.entries(config.roles || {}).find(([, r]) => r === LEAD_ROLE)?.[0];
  const { released, closed } = questionHolds(store.state.work, store.state.questions);
  for (const { id, question } of closed) {
    const key = `${id}/${question}`;
    if (lead && !Object.values(store.state.messages).some(m => m.about?.holdClosed === key))
      apply([{ kind: 'message', payload: { to: lead, work: id, about: { holdClosed: key }, text: `[software factory, automated, not Alex] ${id}: ${question} was closed without an answer, so its hold will never release. Re-point it (triage untilAnswered: the question that replaced it) or re-triage.` } }], 'factory (hold)');
  }
  for (const { id, question } of released)
    apply([{ kind: 'event', target: id, payload: { type: 'hold_released', question } },
      ...(lead ? [{ kind: 'message', payload: { to: lead, work: id, text: `[software factory, automated, not Alex] ${id}: Alex answered ${question}, so its hold is released. Re-triage it.` } }] : [])], 'factory (hold)');
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
  try { apply(sourceCommands(store.state, projectTasks(await readTasks(), process.env.TEAMWORK_SITE, config.support?.projects), 'teamwork', parseAcs), 'poller'); }
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
    // A seat started by hand has no herdr agent name, and `herdr agent prompt <seat>` finds agents by name (W-495).
    for (const r of seatRenames(seatsOf(config), [...fleet.others, ...fleet.units.flatMap(u => [u.supervisor].filter(Boolean))]))
      await herdrRaw('agent', 'rename', r.ref, r.name).then(() => log(`named ${r.label}'s agent ${r.name}`), e => once(`naming ${r.label}: ${e.message}`));
    for (const u of fleet.units) if (u.worker) u.worker.agent = agentOf(config, u.worker.label);
    for (const u of fleet.units) {
      if (u.worker?.status !== 'working') { delete quiet[u.id]; delete screens[u.id]; continue; }
      const stdout = await run('herdr', ['pane', 'read', u.worker.ref, '--source', 'visible', '--lines', '40'], { timeout: 5000 }).then(r => r.stdout, () => null);
      if (stdout == null) continue;
      const h = createHash('sha1').update(stdout.replace(/[^A-Za-z]+/g, '')).digest('hex');
      if (screens[u.id] !== h) { screens[u.id] = h; quiet[u.id] = Date.now(); }
    }
  } catch (e) { log(`fleet: ${e.message}`); }
}

// A repo's local checkout with origin/main fetched (at most once a minute), for checks against main; null when none is here.
const fetchedAt = {};
async function mainGit(repo) {
  const dir = repo === 'built-rails' ? join(homedir(), 'Code/repos/built-rails-a') : Object.values(config.routing.supervisors).map(s => s.repos?.[repo]).find(Boolean)?.replace(/^~/, homedir());
  if (!dir) return null;
  const git = (...a) => run('git', ['-C', dir, ...a], { timeout: 60000, maxBuffer: 1 << 24 });
  if (Date.now() - (fetchedAt[dir] || 0) > 60000) { await git('fetch', '-q', 'origin', 'main').catch(() => {}); fetchedAt[dir] = Date.now(); }
  return git;
}

http.createServer(createApi({ store, config, artifactRoot: ARTIFACTS, gh: DRY ? null : liveGh, tw: DRY ? null : { createTask, getTask, findTask }, onMain: async (repo, m) => {
  // W-435: is this line of code in this file at this commit, and is that commit on origin/main?
  const git = await mainGit(repo);
  if (!git) return true; // ponytail: a repo with no checkout here can't be checked; the fields are still required
  if (!(await git('merge-base', '--is-ancestor', m.sha, 'origin/main').then(() => true, () => false))) return false;
  return (await git('show', `${m.sha}:${m.path}`).then(r => r.stdout, () => '')).includes(String(m.code).trim());
}, onMainFile: async (repo, path) => {
  // W-509: does this file exist on origin/main? An unknown repo counts as yes, so nothing is refused unchecked.
  const git = await mainGit(repo);
  return !git || git('cat-file', '-e', `origin/main:${path}`).then(() => true, () => false);
}, awsHost: DRY ? null : (await import('../hosts/sbx.mjs')).obsAccess(config.aws?.profile), readPr: async url => (await readPrs([url]))[0] || null,
  observed: () => ({ specs: () => ({ ...specView(store.state, specRead()), readAt: projectsRead.readAt }), projects: () => ({ ...buildProjects({ ...projectsRead, works: store.state.work, prs: ownPrs, me: config.githubLogin }), readAt: projectsRead.readAt, me: config.githubLogin }), units: fleet?.units || [], prs: openPrs, prsReadAt, idleSince: watches.idleQueues || {}, graceMs: config.notify?.idleQueueGraceMs ?? 300000, queue: lastPlan, busy: lastBusy, drain, health }) }))
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
// W-471: New-PR records are re-checked for another author's PR on the same files until they are dispatched.
async function duplicateTick() {
  if (DRY) return;
  const repos = [...new Set(unbuiltProposals(store.state).map(repoOf))];
  if (!repos.length) return;
  apply(duplicateCommands(store.state, await readOpenPrFiles(repos, config.githubOwner), { me: config.githubLogin }), 'factory (duplicate check)');
}

// Evolution phase 1 step 2: each review's linked report is copied into data/artifacts by its hash.
async function artifactTick(only) {
  if (DRY) return;
  await retainArtifacts(store, { root: ARTIFACTS, now, only,
    readHost: p => { const abs = p.replace(/^~\//, `${homedir()}/`); if (!abs.startsWith(CODE) || abs.includes('/../')) throw new Error(`${p} is outside ~/Code`); return readFile(abs); },
    readSandbox: (stream, rel) => { const sb = fleet?.units.find(u => u.supervisor?.label === stream)?.worker?.sandbox; if (!sb) throw new Error(`no sandbox found for ${stream}`); return readReport(sb, rel); } });
}

// What each started run ran with: harness, config, factory version and the instruction files, kept by hash.
const FACTORY_VERSION = await run('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD']).then(r => r.stdout.trim(), () => null);
const INSTRUCTIONS = { 'stream-supervisor role': '~/Code/.claude/agents/stream-supervisor.md', 'definition of done': '~/Code/plans/standards/DEFINITION_OF_DONE.md',
  'internal review (claude)': '~/.claude/skills/internal-review/SKILL.md', 'internal review (codex)': '~/Code/plans/standards/internal-review-codex.md' };
async function manifestTick() {
  if (DRY) return;
  // A run pins the spec as it is when it starts, not the last 30-minute read: the worker reads main live (phase 2).
  if (manifestsDue(store.state).length) try { projectsRead = { ...projectsRead, planning: await readPlanning(), readAt: now() }; } catch (e) { once(`planning read for a pin: ${e.message}`); }
  await captureManifests(store, { root: ARTIFACTS, now, home: homedir(), factoryVersion: FACTORY_VERSION, config: readFileSync(join(ROOT, 'config.json'), 'utf8'),
    instructions: Object.fromEntries(Object.entries(INSTRUCTIONS).map(([k, p]) => [k, p.replace(/^~/, homedir())])), read: p => readFile(p),
    harness: stream => { const w = fleet?.units.find(u => u.supervisor?.label === stream)?.worker; return { agent: config.routing.supervisors[stream]?.agent || (w || config.routing.supervisors[stream] ? 'claude' : null), sandbox: w?.sandbox || null, model: tuned[stream]?.model ?? null, effort: tuned[stream]?.effort ?? null }; },
    spec: w => resolveSpec(w, specRead()) });
}

// A verified backup of the log and artifacts, one folder per day; config.backup sets folder, interval, days kept, or off.
const BACKUP = backupPlan(config);
async function backupTick() {
  if (DRY) return;
  const { root, keep } = BACKUP, day = now().slice(0, 10);
  const r = verifyBackup(backup({ db: DB, root: ARTIFACTS, to: join(root, day) }));
  log(`backup ${day}: ${r.events} events, ${r.artifacts} artifacts${r.problems.length ? `, PROBLEMS: ${r.problems.join('; ')}` : ', verified'}`);
  for (const d of readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(0, -keep)) rmSync(join(root, d), { recursive: true, force: true });
}

async function recycleTick() {
  if (!host || !fleet) return;
  for (const u of fleet.units.filter(u => supervisors.includes(u.supervisor?.label) && (u.worker?.sandbox || RC.host !== 'sbx'))) {
    try { health[u.id] = await host.health(u.worker); } catch (e) { once(`health ${u.worker?.label}: ${e.message}`); }
    const note = diskNote(u.worker.label, diskLogged[u.id], health[u.id]?.diskPct, [RC.threshold, RC.hardStop]);
    if (note) { log(note); diskLogged[u.id] = health[u.id].diskPct; }
  }
  // When each worker's agent session started, read inside its sandbox with the disk check.
  const sessions = Object.fromEntries(Object.entries(health).filter(([, h]) => h?.agentSince).map(([k, h]) => [k, h.agentSince]));
  const plan = planRecycles({ units: fleet.units, health, works: store.state.work, threshold: RC.threshold, hardStop: RC.hardStop, recycling, supervisors, sessions, restartStale: !!RC.restartStale });
  drain = plan.drain; hardStops = plan.stop; drainRead = true;
  // A record's model or effort: restart its stream's free worker with them, then the next dispatch tick sends it.
  for (const [to, p] of retune) {
    const u = fleet.units.find(x => x.supervisor?.label === to);
    if (!u?.worker || !['idle', 'done'].includes(u.worker.status) || plan.due.some(d => d.unit === u.id)) continue;
    retune.delete(to);
    if (DRY) { once(`dry run: would restart ${u.worker.label} with ${JSON.stringify(p.want)}`); continue; }
    const r = await host.restart(u.worker, p.want).catch(e => ({ ok: false, detail: e.message }));
    log(`retune ${u.worker.label} for ${p.id}: ${r.ok ? 'done' : 'FAILED'}: ${r.detail}`);
    if (r.ok) { tuned[to] = p.want; writeFileSync(TUNED, JSON.stringify(tuned, null, 2)); delete health[u.id]; }
    else if (!Object.values(store.state.messages).some(m => m.about?.retuneFailed === `${to}/${p.id}`)) apply([{ kind: 'message', payload: { to: LEAD, work: p.id, about: { retuneFailed: `${to}/${p.id}` }, text: `[software factory] Restarting ${u.worker.label} with model ${p.want.model || 'default'}, effort ${p.want.effort || 'default'} for ${p.id} failed: ${r.detail}. ${p.id} waits; file a factory record if it repeats.` } }], 'factory');
  }
  for (const d of plan.due) {
    const tell = (to, about, text) => apply([{ kind: 'message', payload: { to, about, text: `[software factory] ${text}` } }], 'factory');
    if (d.restart) {
      if (DRY) { once(`dry run: would restart ${d.worker.label}`); continue; }
      // A failed restart waits 10 min before the next try, so a broken agent start doesn't loop (11-11, stream-2).
      if (Date.now() - (restartFailedAt[d.unit] || 0) < 600000) continue;
      const r = await host.restart(d.worker).catch(e => ({ ok: false, detail: e.message }));
      log(`restart ${d.worker.label}: ${r.ok ? 'done' : 'FAILED'}: ${r.detail}`);
      if (r.ok) { delete health[d.unit]; tell(d.to, { restarted: `${d.worker.label}/${now()}`, fyi: true }, `${d.worker.label} was restarted between jobs (a fresh session in the same sandbox: repo and disk kept, context gone). Brief it cold. If its pane parks on a startup dialog, send it to local-head.`); }
      else restartFailedAt[d.unit] = Date.now(), tell(LEAD, { restartFailed: `${d.worker.label}/${now()}` }, `Restarting ${d.worker.label} between jobs failed: ${r.detail}. File it as a factory record if it repeats.`);
      continue;
    }
    // Its reviews' reports are copied out first; a sandbox that still holds one isn't removed.
    await artifactTick(w => w.stream === d.to);
    if (unretainedStreams(store.state).has(d.to)) { once(`recycle ${d.worker.label}: waiting to copy its review reports`); continue; }
    const found = releaseFinished(await host.preflight(d.worker).catch(e => [{ path: '(preflight)', problem: e.message, blocking: true }]), store.state.work);
    const problems = found.filter(p => p.blocking), dropped = found.filter(p => !p.blocking).map(p => `${p.path}: ${p.problem}`).join('; ');
    if (problems.some(p => p.unknown)) { once(`recycle ${d.worker.label}: GitHub unreachable, push state unknown; retrying at the next disk check`); continue; }
    if (problems.length) {
      const key = blockKey(d.worker.sandbox, problems), list = problems.map(p => `${p.path}: ${p.problem}`).join('; ');
      if (!Object.values(store.state.messages).some(m => m.about?.recycleBlocked === key))
        for (const to of [d.to, LEAD]) tell(to, { recycleBlocked: key }, `${d.worker.label} is due a recycle (disk ${Math.round(d.diskPct * 100)}%), but this work would be lost with it: ${list}. Push or discard it; the factory retries on its next disk check.`);
      continue;
    }
    if (DRY) { once(`dry run: would recycle ${d.worker.label} (${d.worker.sandbox})`); continue; }
    recycling[d.unit] = { step: 'replacing the sandbox' };
    drain.set(d.to, `recycling ${d.worker.label}`);
    log(`recycle ${d.worker.label}: starting (disk ${Math.round(d.diskPct * 100)}%)`);
    const r = await host.recycle(d.worker, log).catch(e => ({ ok: false, detail: e.message }));
    log(`recycle ${d.worker.label}: ${r.ok ? 'done' : 'FAILED'}: ${r.detail}`);
    if (r.ok) { delete recycling[d.unit]; delete health[d.unit]; tell(d.to, { recycled: `${d.worker.sandbox}/${now()}` }, `${d.worker.label} was recycled (fresh sandbox, clean disk). It has none of its earlier context; brief it cold. If its pane shows Claude's bypass-permissions prompt, that one is Alex's to accept: ask local-head to tell him.${dropped ? ` Discarded with the old sandbox (replaced or stale): ${dropped}.` : ''}`); }
    else { recycling[d.unit] = { step: 'failed', failed: r.detail }; tell(LEAD, { recycleFailed: `${d.worker.sandbox}/${now()}` }, `Recycling ${d.worker.label} failed: ${r.detail}. Its stream takes no new work until this is fixed; file it as a factory record.`); }
  }
}

// Long-lived seats restart fresh once a day at a quiet hour (Alex, 11-09); each starts cold from its handoff file.
// ponytail: the once-a-day mark is in memory, so a live restart inside the hour may restart an idle seat twice.
// Persisted, so a server restart inside the quiet hour can't restart a seat twice the same day.
const RESTARTED = join(dirname(DB), 'seat-restarts.json');
const restartedOn = (() => { try { return JSON.parse(readFileSync(RESTARTED, 'utf8')); } catch { return {}; } })();
// The board tools each seat was last started with (W-431): a changed role restarts the seat at its next gap.
const SEAT_TOOLS = join(dirname(DB), 'seat-tools.json');
const toolsDone = (() => { try { return JSON.parse(readFileSync(SEAT_TOOLS, 'utf8')); } catch { return {}; } })();
const toolsOf = seat => toolsFor(roleOf(config, seat.label)).map(t => t.name).sort().join(',');
async function seatRestartTick() {
  if (!fleet) return;
  const agents = [...fleet.others, ...fleet.units.flatMap(u => [u.supervisor, u.worker].filter(Boolean))];
  for (const { seat, pane } of planSeatRestarts(seatsOf(config), agents, store.state, { now: now(), ...config.seatRecycle, done: restartedOn, toolsOf, toolsDone })) {
    const a = agents.find(x => x.label === seat.label);
    const why = a?.agent && a.agent !== seat.kind ? `switching from ${a.agent} to ${seat.kind}` : toolsDone[seat.label] !== toolsOf(seat) ? 'its factory tools changed' : 'daily fresh start';
    restartedOn[seat.label] = now().slice(0, 10); toolsDone[seat.label] = toolsOf(seat);
    writeFileSync(RESTARTED, JSON.stringify(restartedOn)); writeFileSync(SEAT_TOOLS, JSON.stringify(toolsDone));
    if (DRY) { once(`dry run: would restart ${seat.label}`); continue; }
    const stopped = await stopSeat(seat, pane, herdrRaw).catch(e => { log(`seat restart ${seat.label}: ${e.message}`); return false; });
    const started = stopped && await startSeat(seat, pane, herdrRaw).then(() => true, e => { log(`seat restart ${seat.label}: start failed: ${e.message}`); return false; });
    log(`seat restart ${seat.label} (${why}): ${started ? 'fresh session' : stopped ? 'STOPPED, NOT STARTED: run factory.mjs up' : 'did not exit; left running'}`);
  }
}

// A tick still running skips the next; one slower than a minute is logged so a stalled loop names itself.
const every = (ms, fn) => { let running = false; const run = async () => { if (running) return; running = true; const t0 = Date.now(); let err; try { await fn(); } catch (e) { err = e; log(e.message); } finally { running = false; runtime.tick(fn.name || 'tick', Date.now() - t0, err); if (Date.now() - t0 > 60000) log(`slow tick: ${fn.name || 'tick'} took ${Math.round((Date.now() - t0) / 1000)}s`); } }; run(); setInterval(run, ms); };
setInterval(runtime.flush, 3600000);
await fleetTick();
every(config.poll.fleetMs, fleetTick);
every(config.notify?.intervalMs ?? 15000, inboxTick);
every(config.notify?.intervalMs ?? 15000, readyTick);
every(config.notify?.intervalMs ?? 15000, questionHoldTick);
every(config.poll.githubMs, githubTick);
every(1800000, projectsTick);
every(config.poll.githubMs, rerequestTick);
every(config.poll.teamworkMs, teamworkTick);
every(RC.healthMs, recycleTick);
every(60000, artifactTick);
every(60000, duplicateTick);
every(60000, manifestTick);
if (BACKUP) every(BACKUP.everyMs, backupTick); else log('backups are off (config.backup.enabled is false)');
every(60000, seatRestartTick);
// W-561: each finished worker job's tokens, read in its sandbox before a recycle can take them; and which Claude sessions
// each supervisor seat has had, so the weekly report can total a seat's tokens.
const USAGE_FROM = '2026-11-18T19:50:00.000Z', SEAT_SESSIONS = join(dirname(DB), 'seat-sessions.json');
const seatSessions = (() => { try { return JSON.parse(readFileSync(SEAT_SESSIONS, 'utf8')); } catch { return {}; } })();
every(300000, async function usageTick() {
  if (DRY || !fleet) return;
  let grew = false;
  for (const u of fleet.units) { const s = u.supervisor; if (s?.session && supervisors.includes(s.label) && !seatSessions[s.label]?.[s.session]) { (seatSessions[s.label] ??= {})[s.session] = now(); grew = true; } }
  if (grew) writeFileSync(SEAT_SESSIONS, JSON.stringify(seatSessions, null, 2));
  const workers = fleet.units.filter(u => u.worker?.sandbox && supervisors.includes(u.supervisor?.label)).map(u => u.worker);
  for (const d of usageDue(store.state, { workers: workers.map(x => x.label), since: USAGE_FROM })) {
    const wk = workers.find(x => x.label === d.a.owner), kind = agentOf(config, wk.label) === 'codex' ? 'codex' : 'claude';
    try {
      const r = await readUsage(wk.sandbox, kind, d.windows);
      store.append({ kind: 'manifest', payload: { key: d.key, usage: r.byModel, cost: costOf(r.byModel, config.prices), agent: kind, windows: d.windows } }, by('factory (usage)'));
    } catch (e) { once(`usage ${d.key}: ${e.message}`); }
  }
});
/** Each supervisor seat's tokens over a report window, from its recorded Claude sessions. */
const supervisorUsage = async (since, until) => Promise.all(Object.entries(seatSessions).map(async ([label, ss]) => {
  const usage = await readHostUsage(Object.keys(ss), [[since, until]]).catch(() => ({}));
  return { label, sessions: Object.keys(ss).length, tokens: sumTokens(usage), cost: costOf(usage, config.prices) };
}));
// W-558: the weekly outcomes-by-agent report, Mondays from 10:00 UTC, over the 7 days before; local-head brings it to Alex.
every(3600000, async function outcomesTick() {
  const t = new Date(), day = now().slice(0, 10);
  if (DRY || t.getUTCDay() !== 1 || t.getUTCHours() < 10 || Object.values(store.state.messages).some(m => m.about?.outcomesReport === day)) return;
  const since = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86400000).toISOString(), until = `${day}T00:00:00.000Z`;
  const cfg = { since, until, codexSince: codexSinceOf(config), supervisorUsage: await supervisorUsage(since, until) };
  const out = join(homedir(), 'Code/plans', `factory-outcomes-${day}.md`);
  writeFileSync(out, outcomesMarkdown(outcomes(store.state, cfg), cfg));
  apply([{ kind: 'message', payload: { to: 'local-head', about: { outcomesReport: day }, text: `[software factory, automated, not Alex] This week's outcomes by agent (Claude vs Codex, W-558): ${out}. Give Alex the headline numbers.` } }], 'factory (outcomes)');
});
