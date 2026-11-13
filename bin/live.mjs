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
import { autoDispatchPlan } from '../core/dispatch.mjs';
import { scoutPlan } from '../core/scout.mjs';
import { mergeCloses, holdReleases, questionHolds, watchedPrs, reviewsDue, contradictions } from '../core/units.mjs';
import { TERMINAL, trackOf, stranded, observeHealth, skipNotes, REVIEW_CAP_FROM } from '../core/work.mjs';
import { readPrLines, readPrHealth, readPrs, readMain, readCompare } from '../sources/github.mjs';
import { readTasks, readTopParents, readTaskFeedback, createTask, getTask, findTask } from '../sources/teamwork.mjs';
import { list as readFleet, herdrRaw } from '../fleet/herdr.mjs';
import { seatsOf, planSeatRestarts, stopSeat, startSeat } from '../fleet/factory.mjs';
import { toolsFor } from '../mcp/server.mjs';
import { roleOf } from '../core/api.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogWake } from '../wake/log.mjs';
import { syncResolvedThreads } from '../effects/threads.mjs';
import { autoReadyTick } from '../effects/pr-ready.mjs';
import { planRecycles } from '../core/recycle.mjs';
import { retainArtifacts, unretainedStreams } from '../core/artifacts.mjs';
import { readReport } from '../hosts/sbx.mjs';
import { readFile } from 'node:fs/promises';
import { backup, verifyBackup } from './backup.mjs';
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
const log = (...a) => { console.log(now().slice(11, 19), ...a); appendFileSync(LOG, `${now()} ${a.join(' ')}\n`); };
const by = name => ({ now: now(), by: name });
// One command at a time: a refused observation is logged and the rest still land.
const apply = (cmds, who) => { for (const c of cmds) try { store.append(c, by(who)); } catch (e) { log(`refused ${c.kind} ${c.target || ''}: ${e.message}`); } };

mkdirSync(dirname(DB), { recursive: true });
const store = openStore(DB, { supervisors });
// What the factory leaves alone this tick: the exclude list, plus support records while Alex has support paused.
const skipped = () => ({ exclude: skippedIds(store.state, config) });
log(`${DRY ? 'DRY RUN' : 'live'}: ${DB} at seq ${store.state.seq}`);
// Intake triage covers records created since the final import, the moment V2 became the system of record.
const LIVE_SINCE = store.rows()[0]?.at || now();

let fleet = null, watches = {}, woken = {}, openPrs = new Map(), prsReadAt = null, lastPlan = [];
// Worker hosts (Alex, 11-04): disk readings, cycles under way or failed, and the streams draining for one.
const RC = { enabled: false, threshold: 0.75, host: 'sbx', healthMs: 300000, ...config.recycle };
const host = RC.enabled ? await import(`../hosts/${RC.host}.mjs`) : null;
let health = {}, recycling = {}, drain = new Map(), restartFailedAt = {};
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
  const views = Object.values(s.work).map(w => ({ ...prGateView(s, w), ...derivedCtx(s, w.id, prs) }));
  const terminals = [...(fleet?.others || []), ...(fleet?.units || []).flatMap(u => [u.supervisor, u.worker].filter(Boolean))].filter(a => a.workspace === 'Terminals').map(a => a.label);
  const plan = autoDispatchPlan(views, { supervisors: config.routing.supervisors, ...skipped(), drain, prApproval: config.prApproval, running: tuned }, { terminals });
  lastPlan = plan;
  for (const p of plan.filter(p => p.action === 'retune')) if (!retune.has(p.to)) { retune.set(p.to, p); log(`retune ${p.to} for ${p.id}: ${p.reason}`); }
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
  // Nothing to dispatch and a stream free: send it scouting Sentry (Alex, 11-09). Next tick dispatches the record.
  const scout = scoutPlan(views, plan, { supervisors: config.routing.supervisors, drain, scout: config.scout }, now());
  if (!scout.create) once(`scout: ${scout.reason}`);
  else try { const { id } = store.append({ kind: 'create', payload: scout.create }, by('board (scout)')); log(`scout ${id} for ${scout.to}`); } catch (e) { log(`scout refused: ${e.message}`); }
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
  const plan = inboxCommands(store.state, { ...skipped(), supervisors, seats, workers, hostHowTo, developer, developerSince: '2026-11-05T22:40:00.000Z', now: now(), workerSilentSince: '2026-11-06T17:45:00.000Z', workerSilentMs: config.notify?.workerSilentMs, router: config.routing.questionsRouter, cutoff: since, answersSince: config.notify?.answersSince || since, checkIn, triage, quietMs: config.notify?.quietWorkerMs },
    fleet && { units: fleet.units, others: fleet.others, now: Date.now(), watches, quiet, drain });
  watches = plan.watches;
  for (const c of plan.cmds) { store.append(c, by('board')); log(`message -> ${c.payload.to}: ${JSON.stringify(c.payload.about)}`); }
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
    strandedSince[w.id] ??= t;
    if (t - strandedSince[w.id] < (config.notify?.strandedGraceMs ?? 600000)) continue;
    apply([{ kind: 'event', target: w.id, payload: { type: 'heal', isDraft: openPrs.get(w.links?.pr)?.isDraft ?? null } }], 'board (heal)');
    log(`healed ${w.id} (${w.phase})`); delete strandedSince[w.id];
  }
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
    const health = await readPrHealth([...own], owner, undefined, config.githubLogin, COMMENTS_FROM);
    const main = await readMain([...new Set([...own].map(k => k.split(':')[0]))], owner).catch(e => { once(`main CI read: ${e.message}`); return new Map(); });
    const mainGreen = new Map([...main].map(([r, m]) => [r, m.green])), mainFailing = new Map([...main].map(([r, m]) => [r, m.failing]));
    // Ancestry is read here and logged on the row, so a replay never asks GitHub; a failed read retries next tick.
    const ancestry = new Map();
    if (now() >= REVIEW_CAP_FROM) for (const a of ancestryWanted(s, heads, owner)) try { ancestry.set(a.id, { base: a.base, status: await readCompare(owner, a.repo, a.base, a.head) }); } catch (e) { once(`compare ${a.id}: ${e.message}`); }
    apply([...headCommands(s, heads, { owner, now: now(), standingWaiver: config.standingWaiver, ancestry }), ...healthCommands(s, health, { owner, now: now(), ...skipped(), mainGreen, mainFailing, branches: new Map([...prs].map(([id, p]) => [id, p.branch])) })], 'github');
    apply(sourceCommands(store.state, prs, 'pr', parseAcs, skipped()), 'poller');
    // Hourly audit: anything the read saw that no record holds is a gap in the factory, so the board developer hears of it.
    if (Date.now() - lastAudit >= 3600000) {
      lastAudit = Date.now();
      contradictionsDue = true;
      const dev = Object.entries(config.roles || {}).find(([, r]) => r === 'board-developer')?.[0];
      const told = new Set(Object.values(store.state.messages).map(m => m.about?.missed).filter(Boolean));
      const missed = auditMissed(store.state, own, health, { owner, ...skipped(), prs }).filter(m => !told.has(`${m.key}/${m.id}`));
      log(`audit: ${missed.length} missed`);
      for (const m of missed) if (dev) apply([{ kind: 'message', payload: { to: dev, about: { missed: `${m.key}/${m.id}` }, text: `[software factory, automated, not Alex] Audit: ${m.id === 'pr' ? `own PR ${m.key} has no live record` : `${m.key} feedback from ${m.by} was read but no record holds it: ${m.url}`}. Find why the factory missed it, fix that red-first, then make sure the item reaches its owner.` } }], 'board (audit)');
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
    apply(skipNotes(store.state.work, skipped()), 'board (skip)');
    await mergeTick();
    holdTick();
    // After merge-close, so a merge it just closed is not reported. Once per (kind, record), to the board lead (W-317).
    if (contradictionsDue) {
      contradictionsDue = false;
      const lead = config.boardLead?.seat || 'board lead', told = new Set(Object.values(store.state.messages).map(m => m.about?.contradiction).filter(Boolean));
      const found = contradictions(store.state, { prState: u => openPrs.get(u)?.state || null, now: now() }).filter(c => !told.has(`${c.kind}/${c.id}`));
      log(`audit: ${found.length} contradictions`);
      for (const c of found) apply([{ kind: 'message', payload: { to: lead, work: c.id, about: { contradiction: `${c.kind}/${c.id}` }, text: `[software factory, automated, not Alex] Contradiction on ${c.id} (${c.kind}): ${c.evidence}. Next: ${c.next}.` } }], 'board (audit)');
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
    if (ok) apply([{ kind: 'event', target: r.work, payload: { type: 'reviewer_rerequested', reviewer: r.reviewer, reviewAt: r.reviewAt, head: r.head, state: r.state } }], 'board (re-request)');
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

// A hold past its review date tells its reviewer once per date; the hold stays until someone triages it (W-317).
function reviewTick() {
  for (const d of reviewsDue(store.state.work, now())) {
    const key = `${d.id}/${d.by}`;
    if (Object.values(store.state.messages).some(m => m.about?.reviewDue === key)) continue;
    apply([{ kind: 'message', payload: { to: d.reviewer, work: d.id, about: { reviewDue: key }, text: `[software factory, automated, not Alex] ${d.id}'s hold was due for review on ${d.by}. Look again: re-triage it (ready, a new reviewBy, untilMerged/untilAnswered, deferredTo, or close). The board has not released it.` } }], 'board (hold review)');
  }
}

// A record held until a PR merges (W-292) is released on the merge, and the board lead re-triages it.
function holdTick() {
  const lead = Object.entries(config.roles || {}).find(([, r]) => r === 'board-lead')?.[0];
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

// A record held on a question is released when Alex answers it; one closed unanswered goes back to the board lead.
function questionHoldTick() {
  const lead = Object.entries(config.roles || {}).find(([, r]) => r === 'board-lead')?.[0];
  const { released, closed } = questionHolds(store.state.work, store.state.questions);
  for (const { id, question } of closed) {
    const key = `${id}/${question}`;
    if (lead && !Object.values(store.state.messages).some(m => m.about?.holdClosed === key))
      apply([{ kind: 'message', payload: { to: lead, work: id, about: { holdClosed: key }, text: `[software factory, automated, not Alex] ${id}: ${question} was closed without an answer, so its hold will never release. Re-point it (triage untilAnswered: the question that replaced it) or re-triage.` } }], 'board (hold)');
  }
  for (const { id, question } of released)
    apply([{ kind: 'event', target: id, payload: { type: 'hold_released', question } },
      ...(lead ? [{ kind: 'message', payload: { to: lead, work: id, text: `[software factory, automated, not Alex] ${id}: Alex answered ${question}, so its hold is released. Re-triage it.` } }] : [])], 'board (hold)');
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

http.createServer(createApi({ store, config, artifactRoot: ARTIFACTS, gh: DRY ? null : liveGh, tw: DRY ? null : { createTask, getTask, findTask }, onMain: async (repo, m) => {
  // W-435: is this line of code in this file at this commit, and is that commit on origin/main?
  const dir = repo === 'built-rails' ? join(homedir(), 'Code/repos/built-rails-a') : Object.values(config.routing.supervisors).map(s => s.repos?.[repo]).find(Boolean)?.replace(/^~/, homedir());
  if (!dir) return true; // ponytail: a repo with no checkout here can't be checked; the fields are still required
  const git = (...a) => run('git', ['-C', dir, ...a], { timeout: 60000, maxBuffer: 1 << 24 });
  await git('fetch', '-q', 'origin', 'main').catch(() => {});
  if (!(await git('merge-base', '--is-ancestor', m.sha, 'origin/main').then(() => true, () => false))) return false;
  return (await git('show', `${m.sha}:${m.path}`).then(r => r.stdout, () => '')).includes(String(m.code).trim());
}, awsHost: DRY ? null : (await import('../hosts/sbx.mjs')).obsAccess(config.aws?.profile), readPr: async url => (await readPrs([url]))[0] || null,
  observed: () => ({ units: fleet?.units || [], prs: openPrs, prsReadAt, idleSince: watches.idleQueues || {}, graceMs: config.notify?.idleQueueGraceMs ?? 300000, queue: lastPlan, drain, health }) }))
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
// Evolution phase 1 step 2: each review's linked report is copied into data/artifacts by its hash.
async function artifactTick(only) {
  if (DRY) return;
  await retainArtifacts(store, { root: ARTIFACTS, now, only,
    readHost: p => { const abs = p.replace(/^~\//, `${homedir()}/`); if (!abs.startsWith(CODE) || abs.includes('/../')) throw new Error(`${p} is outside ~/Code`); return readFile(abs); },
    readSandbox: (stream, rel) => { const sb = fleet?.units.find(u => u.supervisor?.label === stream)?.worker?.sandbox; if (!sb) throw new Error(`no sandbox found for ${stream}`); return readReport(sb, rel); } });
}

// A verified backup of the log and artifacts, one folder per day, the last 14 kept.
async function backupTick() {
  if (DRY) return;
  const root = (config.backup?.root || '~/Code/factory-backups').replace(/^~/, homedir()), day = now().slice(0, 10);
  const r = verifyBackup(backup({ db: DB, root: ARTIFACTS, to: join(root, day) }));
  log(`backup ${day}: ${r.events} events, ${r.artifacts} artifacts${r.problems.length ? `, PROBLEMS: ${r.problems.join('; ')}` : ', verified'}`);
  for (const d of readdirSync(root).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort().slice(0, -14)) rmSync(join(root, d), { recursive: true, force: true });
}

async function recycleTick() {
  if (!host || !fleet) return;
  for (const u of fleet.units.filter(u => supervisors.includes(u.supervisor?.label) && (u.worker?.sandbox || RC.host !== 'sbx'))) {
    try { health[u.id] = await host.health(u.worker); } catch (e) { once(`health ${u.worker?.label}: ${e.message}`); }
  }
  // When each worker's agent session started, read inside its sandbox with the disk check.
  const sessions = Object.fromEntries(Object.entries(health).filter(([, h]) => h?.agentSince).map(([k, h]) => [k, h.agentSince]));
  const plan = planRecycles({ units: fleet.units, health, works: store.state.work, threshold: RC.threshold, recycling, supervisors, sessions, restartStale: !!RC.restartStale });
  drain = plan.drain;
  // A record's model or effort: restart its stream's free worker with them, then the next dispatch tick sends it.
  for (const [to, p] of retune) {
    const u = fleet.units.find(x => x.supervisor?.label === to);
    if (!u?.worker || !['idle', 'done'].includes(u.worker.status) || plan.due.some(d => d.unit === u.id)) continue;
    retune.delete(to);
    if (DRY) { once(`dry run: would restart ${u.worker.label} with ${JSON.stringify(p.want)}`); continue; }
    const r = await host.restart(u.worker, p.want).catch(e => ({ ok: false, detail: e.message }));
    log(`retune ${u.worker.label} for ${p.id}: ${r.ok ? 'done' : 'FAILED'}: ${r.detail}`);
    if (r.ok) { tuned[to] = p.want; writeFileSync(TUNED, JSON.stringify(tuned, null, 2)); delete health[u.id]; }
    else if (!Object.values(store.state.messages).some(m => m.about?.retuneFailed === `${to}/${p.id}`)) apply([{ kind: 'message', payload: { to: config.boardLead?.seat || 'board lead', work: p.id, about: { retuneFailed: `${to}/${p.id}` }, text: `[software factory] Restarting ${u.worker.label} with model ${p.want.model || 'default'}, effort ${p.want.effort || 'default'} for ${p.id} failed: ${r.detail}. ${p.id} waits; file a factory record if it repeats.` } }], 'board');
  }
  for (const d of plan.due) {
    const tell = (to, about, text) => apply([{ kind: 'message', payload: { to, about, text: `[software factory] ${text}` } }], 'board');
    if (d.restart) {
      if (DRY) { once(`dry run: would restart ${d.worker.label}`); continue; }
      // A failed restart waits 10 min before the next try, so a broken agent start doesn't loop (11-11, stream-2).
      if (Date.now() - (restartFailedAt[d.unit] || 0) < 600000) continue;
      const r = await host.restart(d.worker).catch(e => ({ ok: false, detail: e.message }));
      log(`restart ${d.worker.label}: ${r.ok ? 'done' : 'FAILED'}: ${r.detail}`);
      if (r.ok) { delete health[d.unit]; tell(d.to, { restarted: `${d.worker.label}/${now()}`, fyi: true }, `${d.worker.label} was restarted between jobs (a fresh session in the same sandbox: repo and disk kept, context gone). Brief it cold. If its pane parks on a startup dialog, send it to local-head.`); }
      else restartFailedAt[d.unit] = Date.now(), tell(config.boardLead?.seat || 'board lead', { restartFailed: `${d.worker.label}/${now()}` }, `Restarting ${d.worker.label} between jobs failed: ${r.detail}. File it as a factory record if it repeats.`);
      continue;
    }
    // Its reviews' reports are copied out first; a sandbox that still holds one isn't removed.
    await artifactTick(w => w.stream === d.to);
    if (unretainedStreams(store.state).has(d.to)) { once(`recycle ${d.worker.label}: waiting to copy its review reports`); continue; }
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
    const why = toolsDone[seat.label] !== toolsOf(seat) ? 'its board tools changed' : 'daily fresh start';
    restartedOn[seat.label] = now().slice(0, 10); toolsDone[seat.label] = toolsOf(seat);
    writeFileSync(RESTARTED, JSON.stringify(restartedOn)); writeFileSync(SEAT_TOOLS, JSON.stringify(toolsDone));
    if (DRY) { once(`dry run: would restart ${seat.label}`); continue; }
    const stopped = await stopSeat(seat, pane, herdrRaw).catch(e => { log(`seat restart ${seat.label}: ${e.message}`); return false; });
    const started = stopped && await startSeat(seat, pane, herdrRaw).then(() => true, e => { log(`seat restart ${seat.label}: start failed: ${e.message}`); return false; });
    log(`seat restart ${seat.label} (${why}): ${started ? 'fresh session' : stopped ? 'STOPPED, NOT STARTED: run factory.mjs up' : 'did not exit; left running'}`);
  }
}

// A tick still running skips the next; one slower than a minute is logged so a stalled loop names itself.
const every = (ms, fn) => { let running = false; const run = async () => { if (running) return; running = true; const t0 = Date.now(); try { await fn(); } catch (e) { log(e.message); } finally { running = false; if (Date.now() - t0 > 60000) log(`slow tick: ${fn.name || 'tick'} took ${Math.round((Date.now() - t0) / 1000)}s`); } }; run(); setInterval(run, ms); };
await fleetTick();
every(config.poll.fleetMs, fleetTick);
every(config.notify?.intervalMs ?? 15000, inboxTick);
every(config.notify?.intervalMs ?? 15000, readyTick);
every(config.notify?.intervalMs ?? 15000, questionHoldTick);
every(config.poll.githubMs, githubTick);
every(config.poll.githubMs, rerequestTick);
every(config.poll.teamworkMs, teamworkTick);
every(RC.healthMs, recycleTick);
every(60000, artifactTick);
every(6 * 3600000, backupTick);
every(60000, seatRestartTick);
