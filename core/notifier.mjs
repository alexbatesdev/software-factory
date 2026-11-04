import { TERMINAL as TERMINAL_PHASES, REVIEWING, queueOrder } from './work.mjs';
// Automatic request pickup: decide which board requests each stream supervisor should hear about, and when.
// Pure functions; the server persists notification records and owns the transport.

export const PREFIX = '[triage-board notifier, automated, not Alex]';
const TERMINAL = TERMINAL_PHASES;

/** Where a record's requests and answers go: its stream, and nothing else. */
export function routeOf(w, supervisors) {
  return w.stream && supervisors.includes(w.stream) ? w.stream : null;
}

/**
 * The stream to record for a record that has none: its latest assignment owner that is a supervisor, else its
 * owner or implementer. Used once per record (server `ensureStream`); reviewer panes are never a stream.
 */
export function inferStream(w, supervisors) {
  const owners = [...(w.assignments || [])].reverse().map(a => a.owner);
  return [...owners, w.owner, w.implementer].find(l => l && supervisors.includes(l)) || null;
}

/**
 * Find the one Claude agent whose pane carries the supervisor's label.
 * Returns {ok, agent} when it may be prompted now, {defer} when it exists but must not be typed into,
 * or {reason} when there is no single such agent.
 */
export function resolveTarget(agents, label) {
  const found = agents.filter(x => x.label === label);
  if (!found.length) return { reason: `"${label}" is not running in herdr.` };
  if (found.length > 1) return { reason: `Several panes are labelled "${label}"; rename one.` };
  const a = found[0];
  if (a.agent !== 'claude') return { reason: `"${label}" is not a Claude agent.` };
  // A blocked agent is parked at a dialog; typing into it could answer the dialog.
  if (!['idle', 'done'].includes(a.agent_status)) return { agent: a, defer: `${label} is ${a.agent_status || 'unknown'}` };
  if (a.interactive_ready === false) return { agent: a, defer: `${label} is not interactive-ready` };
  return { ok: true, agent: a };
}

function current(w, r) {
  if (r.ack || TERMINAL.includes(w.phase)) return false;
  switch (r.type) {
    case 'dispatch': return w.phase === 'queued';
    case 'review': return REVIEWING.includes(w.phase) && r.head === w.head;
    case 'fixes': return w.phase === 'fixes' && r.head === w.head;
    case 'pause': case 'resume': case 'cancel': return true;
    default: return false;
  }
}

/** Unacked requests that still match the item's phase and head. Stale and legacy requests are skipped, never revived. */
export function eligibleRequests(works, cutoff = null, supervisors = []) {
  const out = [];
  for (const w of Object.values(works)) for (const r of w.requests || []) {
    // Requests from before the notifier was first switched on are legacy: shown on the board, never sent.
    if (cutoff && r.at && r.at < cutoff) continue;
    if (current(w, r)) out.push({ key: `${w.id}/${r.id}`, work: w.id, request: r.id, type: r.type, title: w.title, synthetic: !!w.synthetic, to: routeOf(w, supervisors) });
  }
  return out;
}

/**
 * What to send this tick. A request gets one notice and at most one reminder (after cfg.reminderMs).
 * Anything with a send in flight or of uncertain outcome is left alone; only a certain failure is retried.
 */
export function planNotifications(works, notifications, nowMs, cfg) {
  const plan = [];
  const all = Object.values(notifications || {});
  for (const e of eligibleRequests(works, cfg.cutoff, cfg.supervisors)) {
    const hist = all.filter(n => n.requests.includes(e.key));
    if (hist.some(n => ['sending', 'uncertain'].includes(n.status))) continue; // abandoned/failed don't block
    const submitted = hist.filter(n => n.status === 'submitted');
    if (!submitted.length) { plan.push({ ...e, reminder: false }); continue; }
    if (submitted.some(n => (n.reminders || []).includes(e.key) || (n.reminder === true && !n.reminders))) continue;
    const last = Math.max(...submitted.map(n => Date.parse(n.at)));
    if (nowMs - last >= cfg.reminderMs) plan.push({ ...e, reminder: true });
  }
  return plan;
}

/** After a restart, a send that never recorded its outcome may or may not have reached its supervisor. */
export function reconcileOnStart(notifications, now) {
  for (const n of Object.values(notifications || {})) if (n.status === 'sending') Object.assign(n, { status: 'uncertain', detail: 'Server restarted mid-send; outcome unknown.', at2: now });
  return notifications;
}

/** One line, stable W/R ids, nothing to execute. The supervisor's own contract says what to do with it. */
export function notificationText(plan, base, to) {
  const list = plan.map(p => `${p.key} ${p.type}${p.reminder ? ' (reminder)' : ''}${p.synthetic ? ' [SYNTHETIC]' : ''} "${String(p.title).replace(/["\n]/g, "'").slice(0, 60)}"`).join('; ');
  return `${PREFIX} ${plan.length} board request(s) for ${to}: ${list}. Read GET ${base}/api/work/<W> and handle per the README contract; this grants no authority.`;
}

/**
 * Worker stops: a stream's worker went from working to done/idle (and stayed there past graceMs) while one of the
 * stream's records has a started work assignment. sbx workers can't report, so the board wakes their supervisor.
 * @param watch per-unit {armed, stoppedAt}; `working` arms it, a notice disarms it, blocked/unknown leave it alone
 * @returns {{watch, due: [{unit, to, work, assignment, worker, workerRef, stoppedAt}]}}
 */
const startedAt = a => [...(a.history || [])].reverse().find(h => h.status === 'started')?.at || a.at || '';
/**
 * The assignment a stream's worker is on: its most recently started work assignment, or an internal review it runs itself
 * (reviews in a reviewer pane aren't the worker's). [record, assignment] or undefined.
 */
export function workerJob(u, works) {
  const to = u.supervisor?.label;
  return Object.values(works).flatMap(r => r.stream === to ? (r.assignments || []).filter(a => (a.kind !== 'review' || a.owner === u.worker?.label) && a.status === 'started').map(a => [r, a]) : [])
    .sort(([, a], [, b]) => startedAt(a).localeCompare(startedAt(b))).at(-1);
}

export function planWorkerStops({ units, works, watch = {}, now, graceMs = 60000, supervisors }) {
  const next = { ...watch }, due = [];
  for (const u of units) {
    const to = u.supervisor?.label, st = u.worker?.status;
    if (!u.worker || !supervisors.includes(to)) continue;
    const w = next[u.id] || { armed: false, stoppedAt: null };
    if (st === 'working') { next[u.id] = { armed: true, stoppedAt: null }; continue; }
    if (!['done', 'idle'].includes(st)) { next[u.id] = { ...w, stoppedAt: null }; continue; }
    const stoppedAt = w.stoppedAt ?? now;
    next[u.id] = { ...w, stoppedAt };
    if (!w.armed || now - stoppedAt < graceMs) continue;
    const started = workerJob(u, works);
    if (!started) continue;
    next[u.id] = { armed: false, stoppedAt };
    due.push({ unit: u.id, to, work: started[0].id, assignment: started[1].id, version: started[1].version, worker: u.worker.label, workerRef: u.worker.ref, stoppedAt });
  }
  return { watch: next, due };
}

// A stream whose supervisor and worker have both stopped, with nothing started and an assignment queued on it,
// wakes the supervisor once per assignment: the board sends no other start notice for work queued behind a busy stream.
const stopped = a => !a || ['done', 'idle'].includes(a.status);
/** What keeps a stream from starting its next queued assignment, as a phrase, or null when it's free. */
export function streamHold(u, works) {
  const to = u.supervisor?.label;
  // Work blocked on a person doesn't hold the stream (Alex: keep workers on unblocked work while a part waits).
  const started = Object.values(works).flatMap(r => r.stream === to ? (r.assignments || []).filter(a => a.status === 'started').map(a => `${r.id} ${a.id}`) : [])[0];
  if (started) return `behind ${started} (started)`;
  const busy = [u.supervisor, u.worker].find(a => !stopped(a));
  return busy ? `${busy.label} is ${busy.status}` : null;
}

export function planIdleQueues({ units, works, watch = {}, sent = {}, now, graceMs = 300000, supervisors }) {
  const next = {}, due = [];
  for (const u of units) {
    const to = u.supervisor?.label;
    if (!supervisors.includes(to) || streamHold(u, works)) continue;
    const mine = Object.values(works).flatMap(r => r.stream === to ? (r.assignments || []).map(a => [r, a]) : []);
    const q = mine.filter(([, a]) => a.status === 'queued').sort(([r1], [r2]) => queueOrder(r1, r2))
      .map(([r, a]) => ({ to, work: r.id, assignment: a.id, kind: a.kind, key: `${r.id}/${a.id}/v${a.version ?? 1}` })).find(d => !sent[d.key]);
    if (!q) continue;
    next[u.id] = watch[u.id] ?? now;
    if (now - next[u.id] >= graceMs) due.push(q);
  }
  return { watch: next, due };
}
