import { prKey } from './units.mjs';
import { isTrustedReviewSeat } from './capabilities.mjs';
// Work records: the durable lifecycle behind every board item. Pure functions, no I/O.
// The ready gate lives here so no route can set `ready_for_human` or `done` around it.

export const PHASES = ['proposed', 'intake', 'clarification', 'ready', 'queued', 'implementation',
  'review', 'fixes', 'rereview', 'ready_for_human', 'awaiting_human_approval', 'awaiting_alex_review', 'done', 'cancelled'];
// Kinds that finish as a PR need the review/check gate; the rest finish with an accepted artifact.
export const PR_KINDS = ['build', 'pr-feedback'];
// A review runs in the worker's pane, but the record stays its supervisor's (W-172); other assignments take the owner.
const takesOwner = a => a.kind !== 'review';

// Manual transitions only. Review, fixes, re-review, ready and done are reached through events.
const MANUAL = {
  proposed: ['intake'],
  intake: ['clarification', 'ready'],
  clarification: ['intake', 'ready'],
  ready: ['clarification', 'queued'],
  queued: ['ready', 'implementation'],
};
// Phase groups. Every rule that asks "is this record active / building / done" uses these; never retype the list.
export const PRE_QUEUE = ['intake', 'clarification', 'ready'];
export const BUILDING = ['implementation', 'fixes'];
export const REVIEWING = ['review', 'rereview'];
export const AWAITING_HUMAN = ['ready_for_human', 'awaiting_human_approval', 'awaiting_alex_review'];
export const ACTIVE = ['queued', ...BUILDING, ...REVIEWING, ...AWAITING_HUMAN];
export const TERMINAL = ['done', 'cancelled'];
// An assignment still holding its lane.
export const LIVE_ASSIGNMENT = ['queued', 'started', 'blocked'];
// Blocked on something named: the assignment is parked and holds no stream (Alex 11-04: flag it stuck, move on).
export const parked = a => a.status === 'blocked' && !!a.waitingOn;
// Coverage that stops work being queued: an open PR already carries it, or nobody has assessed it. Partial and none are known work left to build.
export const COVERAGE_BLOCKS_QUEUE = ['open-pr', 'unknown'];
/**
 * What kind of work a record is; every guard asks this instead of re-deriving it.
 * @param cfg {exclude} from config.json: records listed in autoDispatch.exclude are never routed, dispatched or drafted
 * @returns {'excluded'|'trusted-review'|'stream'}
 */
// A new PR nobody asked for waits for Alex's go (Alex, 11-09): work that will open one, from a source he hasn't trusted.
// Only `repos` go through PRs (no repo is built-rails); Alex's own tooling commits to main.
// Support work (W-329) and work carrying out Alex's own answer (W-333) were asked for: `support`/`asked` come from store.mjs prGateView.
export const needsPrApproval = (w, { trusted = ['teamwork'], repos } = {}) => ['build', 'pr-feedback'].includes(w.kind) && !w.links?.pr && !w.prApproval && !w.support && !w.asked
  && (!repos || repos.includes(w.repo || 'built-rails')) && !trusted.some(t => t === w.source?.type || t === `${w.source?.type}:${w.source?.by}`);

/** An unstarted record a stream would take, held for Alex's new-PR go: the Approvals list and its card both read this. */
export const wouldAwaitPrApproval = (w, cfg) => !(w.assignments || []).length && (!w.owner || /^sup: /.test(w.owner)) && needsPrApproval(w, cfg);
export const awaitsPrApproval = (w, cfg) => ['ready', 'queued'].includes(w.phase) && wouldAwaitPrApproval(w, cfg);

export function trackOf(w, cfg = {}) {
  if ((cfg.exclude || []).includes(w.id)) return 'excluded';
  if ((w.reviews || []).some(r => r.forAlex) || /^Trusted review/i.test(w.title || '') || /trusted-review$/.test(w.owner || '') || isTrustedReviewSeat(w.owner)) return 'trusted-review';
  return 'stream';
}
// A skip the factory never says out loud hides bugs (11-09: two security PRs read as Mutation for 2.6 days).
const SKIP_NOTE = 'Skipped by the factory: excluded';
/** One note per live record the factory leaves alone as excluded, naming why. */
export function skipNotes(works, cfg = {}) {
  return Object.values(works).filter(w => !TERMINAL.includes(w.phase) && trackOf(w, cfg) === 'excluded' && !(w.updates || []).some(u => u.text?.startsWith(SKIP_NOTE)))
    .map(w => ({ kind: 'event', target: w.id, payload: { type: 'note', text: `${SKIP_NOTE} (listed in autoDispatch.exclude). No dispatch, notices or auto-ready.` } }));
}
/** Queue order everywhere work waits for a stream: priority 1 (Alex's "priority") first, then oldest record. */
// Support work goes ahead of ordinary work (Alex, 11-09); priority 1 still cuts in first.
const rank = w => Math.min(w.priority ?? 3, w.support ? 2 : 3);
export const queueOrder = (a, b) => rank(a) - rank(b) || (a.priority ?? 3) - (b.priority ?? 3) || Number(a.id.slice(2)) - Number(b.id.slice(2));
// A dependency counts as finished once its work is through internal review.
export const SATISFIES_DEPS = ['ready_for_human', 'awaiting_human_approval', 'done'];
const UPDATABLE = ['title', 'objective', 'priority', 'deps', 'owner', 'stream', 'streamPin', 'parent', 'links', 'kind', 'checksApplicable', 'requiredChecks', 'repo', 'externalDeps', 'aliases', 'support', 'model', 'effort', 'alexAsked'];
// What a record may ask its worker to run with (Alex, 11-11, deep-model): a Claude model alias, and an effort both agents accept.
export const TUNING = { model: ['sonnet', 'opus', 'haiku'], effort: ['low', 'medium', 'high', 'xhigh'] };
const checkTuning = f => { for (const k of Object.keys(TUNING)) if (f[k] != null && !TUNING[k].includes(f[k])) fail(`${k} is one of ${TUNING[k].join(', ')} (or default); not "${f[k]}".`); };
// Phases a reconcile may record. Ready-for-review and done always go through their gates.
const RECONCILABLE = ['intake', 'clarification', 'ready', 'queued', 'implementation', 'review'];

const nextId = (list, prefix) => `${prefix}${list.length + 1}`;
const fail = msg => { throw new Error(msg); };

function note(w, ctx, text) {
  w.updates.push({ at: ctx.now, by: ctx.by || 'board', text });
  w.updatedAt = ctx.now;
}

export function createWork(f, ctx) {
  // Ready: only the factory creates work pre-triaged (its Sentry scout); agents' creates are proposed or intake.
  const phase = ['proposed', 'ready'].includes(f.phase) ? f.phase : 'intake';
  const w = {
    id: f.id, title: String(f.title || '').trim() || fail('A work item needs a title.'),
    objective: f.objective || '', kind: f.kind || 'build', repo: f.repo || null,
    priority: Number.isInteger(f.priority) ? f.priority : 3, deps: f.deps || [], owner: f.owner || null, parent: f.parent || null,
    phase, source: f.source || { type: 'manual' }, links: f.links || {},
    criteria: (f.criteria || []).map((text, i) => ({ id: `C${i + 1}`, text, acceptedHead: null, acceptedAt: null })),
    head: null, headVerified: null, implementer: null, prReadyAuth: null, prReadyOps: [], reviews: [], checks: [], findings: [], requests: [], updates: [],
    checksApplicable: f.checksApplicable ?? true, requiredChecks: f.requiredChecks || [], completion: null, paused: false,
    proposedFrom: f.proposedFrom || null, synthetic: f.synthetic === true,
    externalDeps: f.externalDeps || [], aliases: f.aliases || [], reconciled: null, retro: null, coverage: null, related: [], assignments: [], upstream: f.source?.type && f.source.type !== 'manual' ? 'open' : null,
    createdAt: ctx.now, updatedAt: ctx.now,
  };
  checkTuning(f);
  for (const k of Object.keys(TUNING)) if (f[k]) w[k] = f[k];
  if (String(f.alexAsked || '').trim()) w.alexAsked = String(f.alexAsked).trim().slice(0, 1000);
  note(w, ctx, phase === 'proposed' ? `Proposed${w.proposedFrom ? ` from ${w.proposedFrom}` : ''}.` : 'Created.');
  return w;
}

export function updateWork(work, fields, ctx) {
  const w = structuredClone(work);
  for (const k of Object.keys(fields)) {
    if (k === 'addCriteria') continue;
    if (!UPDATABLE.includes(k)) fail(`"${k}" can't be changed with an update; use a lifecycle event.`);
  }
  checkTuning(fields);
  const started = !['proposed', ...PRE_QUEUE].includes(w.phase);
  if (started && 'kind' in fields && fields.kind !== w.kind) fail(`${w.id} has started; its kind can't change (that would change how it finishes).`);
  if (started && 'checksApplicable' in fields && fields.checksApplicable !== w.checksApplicable) fail(`${w.id} has started; whether checks apply can't change now.`);
  if (started && 'requiredChecks' in fields && (w.requiredChecks || []).some(c => !fields.requiredChecks.includes(c))) fail(`${w.id} has started; required checks can be added but not removed.`);
  const prBefore = w.links?.pr;
  for (const k of UPDATABLE) if (k in fields && k !== 'links') w[k] = fields[k];
  // Links merge, so a report naming the PR can't erase the task or artifact links; null removes one.
  if (fields.links) {
    if (fields.links.pr && !prKey(fields.links.pr)) fail(`"${fields.links.pr}" is not a pull request URL; link the full GitHub URL.`);
    // One task, one PR (Alex, 2026-11-02): a replaced PR is unlinked first (pr: null), so a record never carries two.
    if (fields.links.pr && w.links?.pr && prKey(fields.links.pr) !== prKey(w.links.pr)) fail(`${w.id} already carries ${w.links.pr}; a task is never split across PRs. If that PR was replaced, unlink it first (links.pr null).`);
    w.links = { ...(w.links || {}), ...fields.links };
    for (const [k, v] of Object.entries(fields.links)) if (v === null) delete w.links[k];
  }
  if (w.prReadyAuth && w.links?.pr !== prBefore) {
    w.prReadyAuth = null;
    note(w, ctx, 'PR-ready authorization dropped: the linked PR changed.');
  }
  if (fields.priority !== undefined && !(Number.isInteger(w.priority) && w.priority >= 1 && w.priority <= 4)) fail('Priority is 1 (highest) to 4.');
  for (const text of fields.addCriteria || []) w.criteria.push({ id: nextId(w.criteria, 'C'), text, acceptedHead: null, acceptedAt: null });
  note(w, ctx, `Updated ${Object.keys(fields).join(', ')}.`);
  return normalize(w, ctx);
}

/** A ready label never outlives evidence that invalidates it. */
export function normalize(w, ctx = {}) {
  if (w.phase === 'awaiting_human_approval') {
    const wait = w.approvalWait;
    const waived = (w.internalReviewWaivers || []).some(x => x.head === w.head && x.prUrl === w.links?.pr);
    if (wait?.head === w.head && wait.prUrl === w.links?.pr && w.headVerified && (waived || gate(w, ctx).ok)) return w;
    w.phase = 'rereview'; w.approvalWait = null;
    if (ctx.now) note(w, ctx, 'Approval wait invalidated: current PR/head or internal evidence no longer matches. Historical waivers remain history.');
    return w;
  }
  if (w.phase === 'awaiting_alex_review' && !w.reviews.some(r => r.forAlex && sameSha(r.head, w.head))) {
    w.phase = 'rereview';
    if (ctx.now) note(w, ctx, `The PR moved to ${w.head}; the trusted review was of an older commit.`);
    return w;
  }
  // Under the cap, reviewed work with nothing open and no one on it is ready (e.g. its fixes round's findings just settled).
  if (['fixes', ...REVIEWING].includes(w.phase) && !liveAssignment(w) && capped(w, ctx) && gate(w, ctx).ok) {
    w.phase = 'ready_for_human';
    note(w, ctx, `Internal review passed at ${w.head} (reviewed once, findings settled). This is not merged, deployed or complete in Teamwork.`);
    return w;
  }
  if (w.phase !== 'ready_for_human') return w;
  const g = gate(w, ctx);
  if (g.ok) return w;
  w.phase = 'rereview';
  requestRereview(w, ctx);
  if (ctx.now) note(w, ctx, `No longer ready for human review: ${g.reasons.join(' ')}`);
  return w;
}

const isPr = w => PR_KINDS.includes(w.kind);
const prLinked = w => w.source?.type === 'pr' || !!w.links?.pr;
const latest = (list, key) => Object.values(Object.fromEntries(list.map(x => [x[key], x])));

/** Why the item may not be marked ready for human review yet; empty when it may. */
export function gate(w, ctx = {}) {
  const reasons = [];
  if (ctx.openQuestions > 0) reasons.push(`${ctx.openQuestions} open question(s).`);
  if (ctx.openDeps?.length) reasons.push(`Waiting on ${ctx.openDeps.join(', ')}.`);
  for (const d of w.externalDeps || []) reasons.push(`Waiting on ${d.text || d.ref}.`);
  if (!isPr(w)) return { ok: false, reasons: ['This kind finishes with an accepted artifact, not the PR ready gate.'] };
  if (!w.head) reasons.push('No commit recorded yet.');
  else if (prLinked(w) && !w.headVerified) reasons.push(`The PR's current head is not verified (GitHub isn't showing it); report the current head before marking ready.`);
  const review = w.reviews.filter(r => r.head === w.head).at(-1) || inherited(w);
  if (!review) reasons.push(`No independent review at ${w.head || 'the current head'}.`);
  else if (review.result !== 'clean' && w.findings.some(f => f.reviewHead === review.head && f.status === 'open')) reasons.push(`The review at ${review.head} has open findings.`);
  const open = w.findings.filter(f => f.status === 'open');
  if (open.length) reasons.push(`${open.length} finding(s) neither resolved nor accepted.`);
  // Alex, 2026-10-28: "So long as a PR goes through internal review im good with it being marked ready." CI and
  // separately accepted criteria aren't required; the internal review runs the specs and checks the ACs. Named checks still are.
  const checks = latest(w.checks.filter(c => c.head === w.head), 'name');
  for (const name of (w.requiredChecks || []).filter(n => !checks.some(c => c.name === n))) reasons.push(`Required check ${name} has no result at ${w.head || 'the current head'}.`);
  for (const c of checks.filter(c => c.result !== 'pass')) reasons.push(`Check ${c.name} is ${c.result} at ${w.head}.`);
  return { ok: reasons.length === 0, reasons };
}

function setHead(w, sha, ctx, via = 'report', ancestry = null) {
  if (!sha) return;
  w.headVerified = { via, sha, at: ctx.now };
  if (sha === w.head || sameSha(sha, w.head)) {
    // The full form of the current short head (or the reverse) is the same commit: keep the longer one, invalidate nothing.
    if (sha.length > w.head.length) expandHead(w, w.head, sha);
    // A GitHub read can overturn a reported head's assumed lineage.
    if (ctx.now >= REVIEW_CAP_FROM && ancestry && !trace(w, ancestry, w.head, ctx) && [...REVIEWING, 'ready_for_human', 'awaiting_human_approval'].includes(w.phase)) {
      w.phase = 'rereview';
      note(w, ctx, `GitHub shows ${w.head} does not descend from the reviewed ${w.lineage.reviewed} (rebased or force pushed): it needs a new internal review.`);
    }
    return;
  }
  const had = w.head;
  w.head = sha;
  // W-208: CI and conflict findings describe one commit; a new head supersedes them (it gets its own health read).
  if (ctx.now >= FINDINGS_FOLLOW_HEAD_FROM) for (const f of w.findings || []) if (f.status === 'open' && ['ci', 'conflict'].includes(f.source?.type) && !sameSha(f.source.head, sha))
    Object.assign(f, { status: 'resolved', note: `Superseded: the head moved from ${String(f.source.head).slice(0, 7)} to ${sha.slice(0, 7)}.`, at: ctx.now });
  if (w.approvalWait) w.approvalWait = null;
  if (w.prReadyAuth && w.prReadyAuth.head !== sha) {
    w.prReadyAuth = null;
    note(w, ctx, `PR-ready authorization for ${had} dropped: the head is now ${sha}.`);
  }
  const kept = ctx.now >= REVIEW_CAP_FROM && trace(w, ancestry, had, ctx);
  if (kept) note(w, ctx, `New commit ${sha} descends from the reviewed ${w.lineage.reviewed}: no new internal review (one per PR unless rebased or force pushed).`);
  else if (had && [...REVIEWING, 'ready_for_human', 'awaiting_human_approval'].includes(w.phase)) {
    w.phase = 'rereview';
    note(w, ctx, `New commit ${sha} replaces ${had}; review, checks and criteria from ${had} no longer count.`);
  }
}

// Alex, 2026-11-09: one internal review per PR; a later head counts as reviewed while it descends from the reviewed one.
export const REVIEW_CAP_FROM = '2026-11-09T20:10:00.000Z';
const DESCENDS = ['ahead', 'identical', 'assumed'];
const lastReview = w => (w.reviews || []).filter(r => !r.forAlex).at(-1);
/** The internal review the current head inherits through a descending push, if any. Lineage is only set from REVIEW_CAP_FROM. */
const inherited = w => { const r = lastReview(w), l = w.lineage; return r && l && sameSha(l.reviewed, r.head) && sameSha(l.head, w.head) && DESCENDS.includes(l.status) ? r : null; };
/** The reviewed head GitHub should be asked about for this head: none when there's no review or lineage is already read. */
export function ancestryBase(w, sha) {
  const r = lastReview(w), l = w.lineage;
  if (!r || !sha || sameSha(r.head, sha) || (l && sameSha(l.head, sha) && sameSha(l.reviewed, r.head) && !['assumed', 'unknown'].includes(l.status))) return null;
  return r.head;
}
// Records whether the head descends from the last internal review: GitHub's compare status, else assumed from an unbroken line.
// From PR_SWAP_FROM a review of another PR (Alex replaced it, e.g. a hotfix onto production) never carries over (W-374).
const PR_SWAP_FROM = '2026-11-10T22:30:00.000Z';
function trace(w, ancestry, had, ctx) {
  const r = lastReview(w), l = w.lineage;
  if (!r) return false;
  const otherPr = ctx.now >= PR_SWAP_FROM && r.pr && w.links?.pr && r.pr !== w.links.pr;
  const status = otherPr ? 'other-pr' : ancestry && sameSha(ancestry.base, r.head) ? ancestry.status
    : sameSha(r.head, had) || (l && sameSha(l.reviewed, r.head) && sameSha(l.head, had) && DESCENDS.includes(l.status)) ? 'assumed' : 'unknown';
  w.lineage = { reviewed: r.head, head: w.head, status };
  return DESCENDS.includes(status);
}
/** Under the cap, the current head is internally reviewed (at it, or inherited) so no other review is asked for. */
const capped = (w, ctx) => ctx.now >= REVIEW_CAP_FROM && isPr(w) && (w.reviews.some(r => !r.forAlex && sameSha(r.head, w.head)) || !!inherited(w));

function expandHead(w, from, to) {
  const fix = x => { if (x && x.head === from) x.head = to; };
  w.head = to;
  for (const list of [w.requests, w.reviews, w.checks]) (list || []).forEach(fix);
  for (const f of w.findings || []) if (f.reviewHead === from) f.reviewHead = to;
  for (const c of w.criteria || []) if (c.acceptedHead === from) c.acceptedHead = to;
  fix(w.prReadyAuth);
  fix(w.approvalWait);
  (w.internalReviewWaivers || []).forEach(fix);
}

/**
 * Apply one lifecycle event. Returns the new record, plus `spawn` (fields for a new proposed item)
 * when the event is an out-of-scope discovery. Throws with a readable reason when the event is refused.
 */
// Reports often carry an abbreviated SHA; one that abbreviates the current head is that head.
export const sameSha = (a, b) => !!a && !!b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

export function applyEvent(work, e, ctx) {
  const w = structuredClone(work);
  if (w.head) for (const k of ['head', 'sha']) if (sameSha(e[k], w.head)) e = { ...e, [k]: w.head };
  let spawn;
  const terminal = TERMINAL.includes(w.phase);
  // A closed record may still clear a leftover job (W-383) or hand over its key (W-365).
  if (terminal && !['note', 'ack', 'delivery', 'relate', 'cancel_assignment'].includes(e.type) && !(e.type === 'absorb' && w.phase === 'cancelled')) fail(`${w.id} is ${w.phase}.`);

  switch (e.type) {
    case 'waive_internal_review':
    case 'await_approval': {
      const waiverOnly = e.type === 'waive_internal_review';
      if (e.waiver && ctx.now >= REVIEW_CAP_FROM) fail('No internal-review waiver from 2026-11-09 20:10Z: a ready PR never internally reviewed gets one review, and a reviewed one waits without a waiver once the gate passes.');
      if (waiverOnly && !e.waiver) fail('Recording a waiver requires explicit Alex authorization.');
      const pr = (ctx.verifiedPrs || []).find(p => p.url === w.links?.pr);
      if (!e.evidence || !e.head) fail('Approval wait needs current commit and evidence.');
      if (!pr || pr.state !== 'OPEN' || pr.isDraft !== false) fail('GitHub must show the linked PR open and ready just now.');
      if (!sameSha(e.head, pr.head) || !sameSha(w.head, pr.head)) fail('Approval wait must name the current GitHub commit.');
      if (!waiverOnly && liveAssignment(w)) fail('An active assignment must finish before approval wait.');
      if (!waiverOnly && w.requests.some(r => !r.ack)) fail('A pending request must be acknowledged before approval wait.');
      if (e.waiver) {
        if (e.waiver.by !== 'Alex' || !e.waiver.reason || !e.waiver.authorization) fail('An internal-review waiver needs Alex, reason and explicit authorization evidence.');
      } else if (!gate(w, ctx).ok) fail(`Internal review gate: ${gate(w, ctx).reasons.join(' ')}`);
      setHead(w, pr.head, ctx, 'github');
      w.internalReviewWaivers ||= [];
      if (e.waiver && !w.internalReviewWaivers.some(x => x.head === w.head && x.prUrl === pr.url)) {
        w.internalReviewWaivers.push({ ...e.waiver, head: w.head, prUrl: pr.url, at: ctx.now, recordedBy: ctx.by, evidence: e.evidence });
        note(w, ctx, `Alex waived internal review at ${w.head}: ${e.waiver.reason}. Authorization: ${e.waiver.authorization}. This is not a completed review or GitHub approval.`);
      }
      if (!waiverOnly) enterApprovalWait(w, ctx, e.evidence);
      else note(w, ctx, 'Waiver recorded at this head only; phase and current assignment remain unchanged. It never waives later commits.');
      break;
    }
    case 'complete_no_change': {
      const a = w.assignments?.find(x => x.id === e.assignmentId);
      if (!a || a.status !== 'done' || !a.noChange) fail('No-change completion needs a finished assignment with verified no-change evidence.');
      if (Number(e.expectedVersion) !== a.version) fail(`Assignment ${a.id} is at version ${a.version}; re-read it.`);
      if (!e.evidence) fail('No-change completion needs evidence.');
      closeNoChange(w, a, ctx, e.evidence);
      break;
    }
    case 'transition': {
      if (['ready_for_human', 'done', 'cancelled', 'review', 'fixes', 'rereview'].includes(e.to)) fail(`"${e.to}" is reached through its own event, not a transition.`);
      if (!(MANUAL[w.phase] || []).includes(e.to)) fail(`Can't move ${w.id} from ${w.phase} to ${e.to}.`);
      if (e.to === 'ready' && ctx.openQuestions > 0) fail(`${w.id} still has ${ctx.openQuestions} open question(s).`);
      // Covered by an open PR: its feedback lane carries the work, so a second implementation isn't admitted.
      // Unknown, partial or no coverage must be resolved first.
      if (['ready', 'queued'].includes(e.to) && w.coverage && COVERAGE_BLOCKS_QUEUE.includes(w.coverage.state))
        fail(`${w.id} can't be ${e.to === 'ready' ? 'marked ready' : 'queued'}: coverage is ${w.coverage.state}${w.coverage.state === 'open-pr' ? ' (an open PR already carries this work)' : '; resolve it first'}.`);
      if (['queued', 'implementation'].includes(e.to) && ctx.openDeps?.length) fail(`${w.id} is waiting on ${ctx.openDeps.join(', ')}.`);
      if (e.to === 'implementation' && w.externalDeps?.length) fail(`${w.id} is waiting on ${w.externalDeps.map(d => d.text || d.ref).join(', ')}.`);
      if (e.to === 'implementation') { w.owner = e.owner || w.owner; w.implementer = w.owner; }
      w.phase = e.to;
      note(w, ctx, `Moved to ${e.to}${e.owner ? ` (owner ${e.owner})` : ''}.`);
      // Queueing is the dispatch request: the head is notified without another click.
      if (e.to === 'queued' && !w.requests.some(r => r.type === 'dispatch' && !r.ack)) {
        w.requests.push({ id: nextId(w.requests, 'R'), type: 'dispatch', at: ctx.now, by: ctx.by, delivery: 'pending', ack: null });
        note(w, ctx, 'Dispatch requested from the local head.');
      }
      break;
    }
    case 'implementation_done': {
      if (e.noChange) fail('No-change completion needs assignment_done with its assignment id, version and verification evidence.');
      if (!BUILDING.includes(w.phase)) fail(`${w.id} isn't being implemented or fixed (it is ${w.phase}).`);
      const live = liveAssignment(w, 'work');
      if (live && !e.viaAssignment) fail(`${w.id} has a current assignment ${live.id}; report done with --assignment ${live.id} --expect-version ${live.version}.`);
      if (isPr(w) && !e.head) fail('Reporting work done needs the commit (head) it was done at.');
      const from = w.phase;
      // A completion report older than what GitHub shows never rolls the head back; it's flagged for triage.
      if (e.head && w.headVerified?.via === 'github' && w.head && e.head !== w.head) {
        w.staleReports = [...(w.staleReports || []), { reported: e.head, current: w.head, at: ctx.now, by: ctx.by }];
        note(w, ctx, `Done reported at ${e.head}, but GitHub shows ${w.head}; review is requested for ${w.head}. Check the report.`);
      } else setHead(w, e.head, ctx);
      if (capped(w, ctx)) {
        const open = w.findings.filter(f => f.status === 'open');
        w.phase = open.length ? 'fixes' : 'rereview';
        note(w, ctx, `Worker reported done at ${w.head}; it descends from the internal review at ${lastReview(w).head}, so no second review.${open.length ? ` Settle ${open.map(f => f.id).join(', ')} (settle_finding) to mark it ready.` : ''}`);
        break;
      }
      w.phase = from === 'implementation' ? 'review' : 'rereview';
      w.requests.push({ id: nextId(w.requests, 'R'), type: 'review', at: ctx.now, by: ctx.by, delivery: 'pending', ack: null, head: w.head, ...(e.assignmentId ? { assignment: e.assignmentId } : {}) });
      note(w, ctx, `Worker reported done at ${w.head || 'no commit'}; independent review requested.`);
      break;
    }
    case 'head':
      setHead(w, e.sha, ctx);
      break;
    case 'review': {
      // A review can finish after a fixes round opened under it (e.g. GitHub saw a conflict mid-review): it still counts.
      if (![...REVIEWING, 'fixes', 'ready_for_human', 'awaiting_human_approval'].includes(w.phase)) fail(`${w.id} isn't waiting for review (it is ${w.phase}).`);
      // W-294: with no PR the poller can't see a review's pushed fixes, so a review from the current head may move it.
      const moved = e.head !== w.head && !prLinked(w) && e.from && sameSha(e.from, w.head);
      if (e.head !== w.head && !moved) fail(`That review is of ${e.head}, but the current head is ${w.head}.`);
      if (moved) { note(w, ctx, `Head ${w.head} -> ${e.head}: the review pushed its fixes (no PR to observe).`); w.head = e.head; }
      if (!e.by || e.by === w.implementer) fail('A review must be independent of the implementer.');
      if (!['clean', 'findings'].includes(e.result)) fail('A review result is "clean" or "findings".');
      w.reviews.push({ head: e.head, by: e.by, result: e.result, at: ctx.now, link: e.link || null, pr: w.links?.pr || null });
      // A finding may come as plain text (W-160 had four stored with none).
      for (const f of e.findings || []) w.findings.push({ id: nextId(w.findings, 'F'), text: typeof f === 'string' ? f : f.text, severity: f.severity || null, status: 'open', reviewHead: e.head, note: null });
      if (e.result === 'findings' && w.phase !== 'fixes') {
        w.phase = 'fixes';
        w.requests.push({ id: nextId(w.requests, 'R'), type: 'fixes', at: ctx.now, by: ctx.by, delivery: 'pending', ack: null, head: w.head });
      }
      else if (w.phase === 'ready_for_human') w.phase = 'rereview';
      note(w, ctx, `Review at ${e.head} by ${e.by}: ${e.result}${e.findings?.length ? ` (${e.findings.length} finding(s))` : ''}.`);
      if (e.result === 'clean') {
        // A clean review of a later head saw the fixes, so it settles the earlier rounds' findings.
        // From W-210 on, a later clean review of the same head is the final word on that head's findings too.
        for (const f of w.findings.filter(f => f.status === 'open' && f.reviewHead && (f.reviewHead !== e.head || ctx.now >= SAME_HEAD_CLEAN_FROM))) Object.assign(f, { status: 'resolved', note: `Resolved by the clean review at ${e.head}.` });
        if (REVIEWING.includes(w.phase) && gate(w, ctx).ok) { w.phase = 'ready_for_human'; note(w, ctx, `Internal review passed at ${w.head}. This is not merged, deployed or complete in Teamwork.`); }
      }
      break;
    }
    case 'review_for_alex': {
      // A trusted review of someone else's PR: Alex reads the result and submits his own review. Not our ready gate.
      if (!REVIEWING.includes(w.phase)) fail(`${w.id} isn't waiting for review (it is ${w.phase}).`);
      if (!['clean', 'findings'].includes(e.result) || !e.head || !e.artifact) fail('A review result needs head, result (clean or findings) and the artifact.');
      w.reviews.push({ head: e.head, by: ctx.by, result: e.result, at: ctx.now, link: e.artifact, forAlex: true });
      for (const f of e.findings || []) w.findings.push({ id: nextId(w.findings, 'F'), text: f.text, severity: f.severity || null, status: 'open', reviewHead: e.head, note: null });
      if (sameSha(e.head, w.head)) w.phase = 'awaiting_alex_review';
      note(w, ctx, `Trusted review at ${e.head}: ${e.result}${e.findings?.length ? ` (${e.findings.length} item(s) for Alex)` : ''}. Result: ${e.artifact}.${w.phase === 'awaiting_alex_review' ? ' Alex to read it and submit his own review.' : ` The PR is now at ${w.head}; that needs a new review.`}`);
      break;
    }
    case 'merged': {
      // The poller saw the PR(s) this work is implemented in merge, verified on GitHub just now. Teamwork closure stays human.
      if (!e.prs?.length || e.prs.some(p => p.state !== 'MERGED')) fail('Closing as merged needs every PR verified merged just now.');
      w.phase = 'done';
      w.completion = { kind: 'merged', prs: e.prs.map(p => ({ url: p.url, mergedAt: p.mergedAt || null })), at: ctx.now, by: ctx.by };
      note(w, ctx, `Done: ${e.prs.map(p => `#${String(p.url).split('/pull/')[1]}`).join(', ')} merged. Not closed in Teamwork.${e.outstanding?.length ? ` Alex merged past: ${e.outstanding.join('; ')}.` : ''}`);
      if (e.outstanding?.length) w.waitingOn = null;
      break;
    }
    case 'alex_review_seen': {
      // The poller saw Alex's own review on GitHub, or the PR closed before he reviewed it.
      if (!w.reviews.some(r => r.forAlex) || TERMINAL.includes(w.phase)) fail(`${w.id} has no trusted review waiting on Alex.`);
      w.phase = 'done';
      if (e.review) {
        w.completion = { kind: 'alex-review', review: e.review, at: ctx.now, by: ctx.by };
        note(w, ctx, `Alex submitted his review on GitHub: ${e.review.state} at ${e.review.at}.`);
      } else {
        w.completion = { kind: 'closed-before-alex-review', closedAs: e.closedAs, at: ctx.now, by: ctx.by };
        note(w, ctx, `The PR is ${e.closedAs} without a review from Alex; nothing left to submit.`);
      }
      break;
    }
    case 'alex_review_submitted':
      if (w.phase !== 'awaiting_alex_review') fail(`${w.id} isn't waiting for Alex's review (it is ${w.phase}).`);
      w.phase = 'done';
      w.completion = { kind: 'alex-review', note: e.note || null, at: ctx.now, by: ctx.by };
      note(w, ctx, `Alex submitted his review${e.note ? `: ${e.note}` : ''}.`);
      break;
    case 'finding': {
      const f = w.findings.find(x => x.id === e.findingId) || fail(`No finding ${e.findingId}.`);
      if (!['resolved', 'accepted', 'open'].includes(e.status)) fail('A finding is open, resolved or accepted.');
      if (e.status === 'accepted' && !e.note) fail('Accepting a finding without fixing it needs a note saying why.');
      Object.assign(f, { status: e.status, note: e.note || null, at: ctx.now });
      note(w, ctx, `Finding ${f.id} ${e.status}${e.note ? `: ${e.note}` : ''}.`);
      break;
    }
    case 'check':
      if (!e.name || !['pass', 'fail'].includes(e.result)) fail('A check needs a name and a result of pass or fail.');
      if (isPr(w) && e.head !== w.head) fail(`That check ran at ${e.head}, but the current head is ${w.head}.`);
      w.checks.push({ name: e.name, head: e.head || null, result: e.result, at: ctx.now, evidence: e.evidence || null });
      note(w, ctx, `Check ${e.name}: ${e.result}${e.head ? ` at ${e.head}` : ''}.`);
      break;
    case 'criterion': {
      const c = w.criteria.find(x => x.id === e.criterionId) || fail(`No criterion ${e.criterionId}.`);
      if (isPr(w) && e.accepted && e.head !== w.head) fail(`Criteria are accepted against the current head (${w.head}).`);
      c.acceptedHead = e.accepted ? (isPr(w) ? e.head : null) : null;
      c.acceptedAt = e.accepted ? ctx.now : null;
      c.accepted = !!e.accepted;
      note(w, ctx, `Criterion ${c.id} ${e.accepted ? 'accepted' : 'reopened'}.`);
      break;
    }
    case 'mark_ready': {
      if (w.phase === 'ready_for_human') break; // a clean review already moved it
      if (!REVIEWING.includes(w.phase)) fail(`${w.id} is in ${w.phase}; only reviewed work can be marked ready (fixes need re-review first).`);
      const g = gate(w, ctx);
      if (!g.ok) fail(`Not ready for review: ${g.reasons.join(' ')}`);
      w.phase = 'ready_for_human';
      note(w, ctx, `Ready for human review at ${w.head}. This is not merged, deployed or complete in Teamwork.`);
      break;
    }
    case 'complete': {
      if (isPr(w)) fail('PR work finishes through the ready gate, not "complete".');
      if (!e.artifact) fail('Completing non-PR work needs the accepted report or artifact.');
      const open = w.criteria.filter(c => !c.accepted);
      if (open.length || !w.criteria.length) fail(`${open.length || 'No'} acceptance criteri${open.length === 1 ? 'on' : 'a'} ${open.length ? 'not accepted' : 'recorded'}.`);
      w.completion = { artifact: e.artifact, at: ctx.now, by: ctx.by };
      w.phase = 'done';
      note(w, ctx, `Completed with ${e.artifact}.`);
      break;
    }
    case 'resolve': {
      // Work with no PR and no criteria to accept (a factory fix, a manual chore) closes on a note saying what settled it.
      if (prLinked(w) && !e.prClosed) fail('PR work finishes through the ready gate, not "resolve" (unless its PR was closed unmerged).');
      if (w.criteria.length) fail(`${w.id} has acceptance criteria; complete it against them.`);
      if (!e.note) fail('Resolving needs a note saying what settled it (a commit, or who did it).');
      w.completion = { kind: 'resolved', note: e.note, at: ctx.now, by: ctx.by };
      w.phase = 'done';
      // Ungated (W-204): done records take no later events, so replaying old resolves this way can't refuse anything.
      for (const x of w.assignments || []) if (LIVE_ASSIGNMENT.includes(x.status)) { x.history.push({ status: x.status, at: ctx.now, by: ctx.by }); x.status = 'cancelled'; x.version++; }
      note(w, ctx, `Resolved: ${e.note}`);
      break;
    }
    case 'discovery':
      if (!e.text) fail('A discovery needs text.');
      if (e.inScope) {
        w.findings.push({ id: nextId(w.findings, 'F'), text: e.text, severity: e.severity || null, status: 'open', reviewHead: null, note: null });
        note(w, ctx, `In-scope discovery recorded as a finding: ${e.text}`);
      } else {
        spawn = { title: e.text, objective: e.objective || '', kind: e.kind || (w.kind === 'scout' ? 'build' : w.kind), repo: w.repo, phase: 'proposed', proposedFrom: w.id };
        note(w, ctx, `Out-of-scope discovery proposed as separate work: ${e.text}`);
      }
      break;
    case 'request': {
      if (!['pause', 'cancel', 'resume', 'dispatch'].includes(e.request)) fail('A request is pause, resume, cancel or dispatch.');
      const same = w.requests.find(r => r.type === e.request && !r.ack);
      if (same) { note(w, ctx, `${e.request} already requested (${same.id}); not repeated.`); break; }
      w.requests.push({ id: nextId(w.requests, 'R'), type: e.request, at: ctx.now, by: ctx.by, delivery: 'pending', ack: null, detail: e.detail || null });
      note(w, ctx, `Requested ${e.request}. Nothing changes until it is acknowledged.`);
      break;
    }
    case 'delivery': {
      const r = w.requests.find(x => x.id === e.requestId) || fail(`No request ${e.requestId}.`);
      if (!['pending', 'written', 'failed', 'uncertain', 'unsupported'].includes(e.status)) fail('Unknown delivery status.');
      Object.assign(r, { delivery: e.status, deliveryDetail: e.detail || null, deliveryAt: ctx.now });
      note(w, ctx, `Request ${r.id} (${r.type}) delivery: ${e.status}${e.detail ? ` (${e.detail})` : ''}.`);
      break;
    }
    case 'ack': {
      const r = w.requests.find(x => x.id === e.requestId) || fail(`No request ${e.requestId}.`);
      if (!e.by) fail('An acknowledgment needs who acknowledged it.');
      if (!['done', 'declined', 'received'].includes(e.outcome)) fail('An ack outcome is received, done or declined.');
      r.ack = { by: e.by, outcome: e.outcome, note: e.note || null, at: ctx.now };
      // A declined fixes request is the supervisor's word that nothing in it needs a change (W-255): its open findings stand.
      if (e.outcome === 'declined' && r.type === 'fixes' && ctx.now >= DECLINE_SETTLES_FROM)
        for (const f of w.findings.filter(f => f.status === 'open')) Object.assign(f, { status: 'accepted', note: `Declined with ${r.id} by ${e.by}${e.note ? `: ${e.note}` : ''}`, at: ctx.now });
      if (e.outcome === 'done') {
        if (r.type === 'cancel') w.phase = 'cancelled';
        if (r.type === 'pause') w.paused = true;
        if (r.type === 'resume') w.paused = false;
      }
      note(w, ctx, `${e.by} acknowledged ${r.type} (${r.id}): ${e.outcome}${e.note ? `, ${e.note}` : ''}.`);
      break;
    }
    case 'authorize_pr_ready': {
      const link = w.links?.pr;
      if (!link) fail(`${w.id} has no linked PR.`);
      if (e.prUrl !== link) fail(`That authorization names ${e.prUrl}, but the linked PR is ${link}.`);
      if (!w.head || e.head !== w.head) fail(`Authorization must name the current head (${w.head || 'none recorded'}).`);
      w.prReadyAuth = { prUrl: e.prUrl, head: e.head, by: ctx.by, at: ctx.now };
      note(w, ctx, `Marking ${e.prUrl} ready on GitHub authorized at ${e.head} only. Merging is never authorized here.`);
      break;
    }
    case 'pr_ready_op': {
      // Server-only: records each attempt's state. Confirmed means a readback showed the head and isDraft=false.
      const op = w.prReadyOps.find(o => o.id === e.opId);
      if (op) {
        // Earlier states stay in the attempt's history; nothing is overwritten without a trace.
        op.history = [...(op.history || []), { status: op.status, detail: op.detail, at: op.at, ...(op.observed ? { observed: op.observed } : {}) }];
        Object.assign(op, { status: e.status, detail: e.detail || null, at: ctx.now, ...(e.outcome ? { outcome: e.outcome } : {}), ...(e.observed ? { observed: e.observed } : {}) });
      } else w.prReadyOps.push({ id: e.opId, status: e.status, head: e.head, prUrl: e.prUrl, detail: e.detail || null, at: ctx.now, history: [] });
      if (e.status === 'confirmed' && w.phase === 'ready_for_human' && gate(w, ctx).ok) enterApprovalWait(w, ctx, `Confirmed PR-ready operation ${e.opId}`);
      note(w, ctx, `PR ready on GitHub (${e.opId}): ${e.status}${e.outcome ? `, ${e.outcome}` : ''}${e.detail ? ` (${e.detail})` : ''}.`);
      break;
    }
    case 'reconcile': {
      // Records work that is already assigned or running. Never a queue command: no request, so no notice.
      if (!RECONCILABLE.includes(e.phase)) fail(`Can't reconcile to "${e.phase}"; reconcile records ${RECONCILABLE.join(', ')}.`);
      if (!e.evidence) fail('A reconcile needs evidence (a brief, report or ledger path, or quoted text).');
      if (liveAssignment(w)) fail(`${w.id} has a current assignment ${liveAssignment(w).id}; report it with progress or done --assignment.`);
      const from = w.phase;
      if (e.owner) w.owner = e.owner;
      if (e.phase === 'implementation') w.implementer = w.owner;
      // A report can be older than what GitHub shows; a head GitHub verified is never overwritten by one.
      if (e.head && w.headVerified?.via === 'github' && w.head && e.head !== w.head) note(w, ctx, `Reported head ${e.head} ignored; GitHub shows ${w.head}.`);
      else if (e.head) setHead(w, e.head, ctx);
      w.phase = e.phase;
      w.reconciled = { at: ctx.now, by: ctx.by, evidence: e.evidence, from };
      note(w, ctx, `Reconciled ${from} → ${e.phase}${e.owner ? ` (owner ${e.owner})` : ''} from evidence: ${e.evidence}. Nothing was dispatched.`);
      break;
    }
    case 'retro_close': {
      // Work that finished before the board tracked it. Closed with its evidence, never with invented reviews,
      // checks or accepted criteria, and never by the ordinary ready gate.
      if (!['completed', 'superseded', 'duplicate', 'settled'].includes(e.outcome)) fail('A retrospective outcome is completed, superseded, duplicate or settled.');
      // Checked here too, at commit: whatever happened while evidence was being read, active work is never closed this way.
      if (ACTIVE.includes(w.phase)) fail(`${w.id} is active (${w.phase}); retrospective close is only for work the board never tracked.`);
      if (w.owner) fail(`${w.id} is assigned to ${w.owner}.`);
      if (w.requests.some(r => !r.ack)) fail(`${w.id} has an unacknowledged request.`);
      if (!e.evidence) fail('A retrospective close needs evidence.');
      let prs = [];
      if (e.outcome === 'completed') {
        if (e.coverage !== 'full') fail('Completed needs full coverage of the item\'s scope; record partial coverage instead.');
        if (!e.prs?.length) fail('Completed needs the PRs that cover it.');
        for (const p of e.prs) {
          const v = (ctx.verifiedPrs || []).find(x => x.url === p.url);
          const n = (p.url.match(/pull\/(\d+)/) || [])[1];
          if (!v) fail(`#${n} wasn't verified on GitHub just now.`);
          if (v.state !== 'MERGED') fail(`#${n} is ${v.state}, not merged.`);
          prs.push({ url: v.url, state: v.state, head: v.head || null, mergedAt: v.mergedAt || null, verifiedAt: ctx.now });
        }
      } else if (e.outcome === 'settled') { if (!e.decision) fail('Settled needs the decision that settled it (nothing to build).'); }
      else if (!e.target) fail(`${e.outcome} needs the target it ${e.outcome === 'duplicate' ? 'duplicates' : 'was superseded by'}.`);
      w.retro = { outcome: e.outcome, coverage: e.coverage || null, prs, target: e.target || null, decision: e.decision || null, evidence: e.evidence, matrix: e.matrix || null,
        reason: 'Historical reconciliation: the work finished before the board tracked it. Closed on the cited evidence; no board review, check or criteria acceptance was run or recorded.',
        by: ctx.by, at: ctx.now, from: w.phase };
      w.phase = 'done';
      note(w, ctx, `Closed retrospectively as ${e.outcome}${e.target ? ` (${e.target})` : ''}${prs.length ? ` by ${prs.map(p => '#' + p.url.split('/pull/')[1]).join(', ')} (merged, verified now)` : ''}. Evidence: ${e.evidence}. No board review or gate was run.`);
      break;
    }
    case 'coverage': {
      // What existing PRs cover, without closing: an open PR is not done and not proof anyone is working on it.
      if (!['open-pr', 'partial', 'none', 'unknown'].includes(e.state)) fail('Coverage is open-pr, partial, none or unknown.');
      if (!e.evidence) fail('Coverage needs evidence.');
      if (e.state === 'open-pr' && !(ctx.verifiedPrs || []).some(p => p.state === 'OPEN'))
        fail(`None of the cited PRs is open now (${(e.prs || []).map(p => `#${String(p.url).split('/pull/')[1]} ${(ctx.verifiedPrs || []).find(v => v.url === p.url)?.state || 'unreadable'}`).join(', ') || 'none cited'}); record it as unknown or partial and reconcile.`);
      w.coverage = { state: e.state, prs: e.prs || [], missing: e.missing || null, evidence: e.evidence, by: ctx.by, at: ctx.now };
      if (e.prs?.[0]?.url && !w.links?.pr && e.prs.length === 1) w.links = { ...(w.links || {}), pr: e.prs[0].url };
      note(w, ctx, `Coverage: ${e.state}${e.prs?.length ? ` (${e.prs.map(p => `#${p.url.split('/pull/')[1]} ${p.state || ''}`.trim()).join(', ')})` : ''}${e.missing ? `; missing: ${e.missing}` : ''}. Evidence: ${e.evidence}.`);
      break;
    }
    case 'assign': {
      // Records a dispatch the head made natively; the board never repeats it. No request, so no notice.
      if (!e.assignmentId || !['implementation', 'fixes', 'review', 'discovery'].includes(e.kind)) fail('assign needs an assignment id and a kind (implementation, fixes, review, discovery).');
      if (!['queued', 'started', 'done'].includes(e.status)) fail('An assignment is recorded as queued, started or done.');
      if (!e.evidence) fail('assign needs evidence (the brief or dispatch message).');
      if ((w.assignments || []).some(a => a.id === e.assignmentId)) fail(`${e.assignmentId} is already recorded on ${w.id}; report its stage with progress.`);
      if (e.status === 'done') {
        // History only: the phase, owner and requests already reflect the finished work.
        if (liveAssignment(w, laneOf(e))) fail(`${liveAssignment(w, laneOf(e)).id} is the current assignment on ${w.id}; finish it with done --assignment.`);
        if (isPr(w) && !sameSha(e.head, w.head)) fail(`A finished assignment is recorded at the current head (${w.head || 'none'}), not ${e.head || 'none'}.`);
        w.assignments = [...(w.assignments || []), { id: e.assignmentId, kind: e.kind, owner: e.owner || null, status: 'done', version: 1, brief: e.brief || null, evidence: e.evidence, dependsOn: [], after: [], doneHead: w.head || null, at: ctx.now, by: ctx.by, history: [] }];
        note(w, ctx, `Assignment ${e.assignmentId} (${e.kind}) recorded as already done${w.head ? ` at ${w.head}` : ''}. Evidence: ${e.evidence}.`);
        break;
      }
      // Reviews and work (implementation, fixes, discovery) are separate lanes, each with one current assignment.
      const live = liveAssignment(w, laneOf(e)), other = liveAssignment(w, laneOf(e) === 'review' ? 'work' : 'review');
      const waits = e.afterAssignments || [];
      if (other && laneOf(e) === 'work' && !e.parallel && !waits.includes(other.id)) fail(`${other.id} (${other.kind}) is running on ${w.id}; queue this with --after-assignment ${other.id}, or --parallel to run alongside it.`);
      for (const id of waits) if (!(w.assignments || []).some(x => x.id === id)) fail(`${id} isn't recorded on ${w.id}.`);
      if (live && e.supersedes !== live.id) fail(`${live.id} is the current assignment on ${w.id}; to replace it, assign with --supersedes ${live.id} --expect-version ${live.version}.`);
      if (live && Number(e.expectedVersion) !== live.version) fail(`${live.id} is at version ${live.version}, not ${e.expectedVersion}; re-read it before replacing it.`);
      if (live) { live.history.push({ status: live.status, at: ctx.now, by: ctx.by, note: `superseded by ${e.assignmentId}` }); live.status = 'superseded'; }
      if (e.dependsOn?.length) w.deps = [...new Set([...(w.deps || []), ...e.dependsOn])];
      const a = { id: e.assignmentId, kind: e.kind, owner: e.owner || null, status: 'queued', version: 1, brief: e.brief || null, evidence: e.evidence, dependsOn: e.dependsOn || [], after: e.after || [], afterAssignments: waits, parallel: !!e.parallel, at: ctx.now, by: ctx.by, history: [], recordedFrom: { phase: w.phase, head: w.head, prUrl: w.links?.pr || null } };
      w.assignments = [...(w.assignments || []), a];
      if (e.owner && takesOwner(e) && (!other || e.status === 'started')) w.owner = e.owner;
      if (PRE_QUEUE.includes(w.phase)) w.phase = 'queued';
      note(w, ctx, `Assignment ${a.id} (${a.kind}) recorded as queued${a.owner ? ` for ${a.owner}` : ''}${a.dependsOn.length ? `, depending on ${a.dependsOn.join(', ')}` : ''}${a.after.length ? `, after ${a.after.join(', ')}'s worker finishes` : ''}${waits.length ? `, after ${waits.join(', ')} ends` : ''}${a.parallel ? `, in parallel with ${other?.id}` : ''}. Evidence: ${e.evidence}.`);
      if (e.status === 'started') startAssignment(w, a, ctx, false); // recorded as started: still version 1
      break;
    }
    case 'progress': {
      const a = currentAssignment(w, e.assignmentId, e.expectedVersion);
      if (!['started', 'working', 'blocked'].includes(e.stage)) fail('A progress stage is started, working or blocked.');
      if (e.waitingOn !== undefined && (e.stage !== 'blocked' || typeof e.waitingOn !== 'string')) fail('waitingOn names what a blocked assignment waits on: TB-n, W-n or a short text.');
      if (e.stage === 'started') { if (a.status !== 'queued' && a.status !== 'blocked') fail(`${a.id} is already ${a.status}.`); startAssignment(w, a, ctx); if (a.waitingOn) { a.waitingOn = null; a.waitingActor = null; } }
      else {
        if (e.stage === 'working' && a.status !== 'started') fail(`${a.id} is ${a.status}; report --stage started before working.`);
        a.history.push({ status: a.status, at: ctx.now, by: ctx.by }); a.status = e.stage === 'blocked' ? 'blocked' : a.status; a.version++;
        if (e.stage === 'blocked') { a.waitingOn = e.waitingOn?.trim() || null; a.waitingActor = e.actor || null; }
      }
      if (e.text) note(w, ctx, `${a.id} ${e.stage}: ${e.text}`);
      break;
    }
    case 'cancel_assignment': {
      // A mis-filed assignment: its history stays, the phase is whatever the record's other evidence says.
      const a = currentAssignment(w, e.assignmentId, e.expectedVersion);
      if (!e.evidence) fail('Cancelling an assignment needs evidence.');
      a.history.push({ status: a.status, at: ctx.now, by: ctx.by }); a.status = 'cancelled'; a.version++;
      note(w, ctx, `Assignment ${a.id} cancelled. Evidence: ${e.evidence}.`);
      break;
    }
    case 'assignment_done': {
      const a = currentAssignment(w, e.assignmentId, e.expectedVersion);
      if (e.noChange) {
        // A regular check with no code deliverable finishes without an internal code review.
        if (!e.noChange.verifiedOn || !e.noChange.evidence) fail('A no-change close needs --verified-on <sha> and --evidence.');
        a.history.push({ status: a.status, at: ctx.now, by: ctx.by }); a.status = 'done'; a.version++; a.noChange = { ...e.noChange, at: ctx.now, by: ctx.by };
        note(w, ctx, `Assignment ${a.id} closed with no change: already satisfied on ${e.noChange.verifiedOn}. Evidence: ${e.noChange.evidence}. Nothing was built.`);
        if (e.head && !sameSha(e.head, e.noChange.verifiedOn)) fail('No-change head must match its verified commit.');
        // Its PR already merged (W-251): the check ran on main, so it closes the record like work with no PR.
        const merged = ctx.prState?.state === 'MERGED' && ctx.prState.url === w.links?.pr;
        if (prLinked(w) && !merged) finishNoChangeProbe(w, a, ctx);
        else closeNoChange(w, a, ctx, e.noChange.evidence, merged);
        break;
      }
      if (BUILDING.includes(a.kind) && e.head) {
        // ctx.prHead is the server's fresh read of the linked PR (null: unreadable or no PR).
        if (ctx.prHead && !sameSha(e.head, ctx.prHead)) fail(`Done reported at ${e.head}, but GitHub shows ${ctx.prHead}; report done at the pushed head.`);
        if (ctx.prHead) setHead(w, ctx.prHead, ctx, 'github');
        else if (w.headVerified?.via === 'github' && w.head && !sameSha(e.head, w.head)) fail(`Done reported at ${e.head}, but GitHub last showed ${w.head} and can't confirm the new head now; retry when the PR is readable.`);
      }
      if (BUILDING.includes(a.kind)) {
        // Same path as a worker's done: independent review is requested, nothing is marked reviewed or ready.
        const r = applyEvent(w, { type: 'implementation_done', head: ctx.prHead || e.head, viaAssignment: true, assignmentId: a.id }, ctx).work;
        Object.assign(w, r);
      }
      const cur = w.assignments.find(x => x.id === a.id);
      cur.history.push({ status: cur.status, at: ctx.now, by: ctx.by }); cur.status = 'done'; cur.version++; cur.doneHead = e.head || null;
      note(w, ctx, `Assignment ${a.id} done${e.head ? ` at ${e.head}` : ''}.`);
      break;
    }
    case 'correct_head': {
      // Undo a false "new commit" move made before short and full SHAs were treated as one commit. The old entry stays.
      if (!sameSha(e.from, e.to) || !sameSha(w.head, e.to)) fail(`${e.from} and ${e.to} aren't the same commit as the current head ${w.head}.`);
      if (w.phase !== 'rereview' || !['review'].includes(e.phase)) fail('correct_head only moves a false rereview back to review.');
      if (w.reviews.some(r => sameSha(r.head, e.to))) fail(`A review already ran at ${e.to}; nothing to correct.`);
      if (!e.evidence) fail('correct_head needs evidence.');
      expandHead(w, e.from, e.to.length > w.head.length ? e.to : w.head);
      w.phase = e.phase;
      note(w, ctx, `Correction: ${e.to} is the same commit as ${e.from}, not a new one; back to ${e.phase}. Evidence: ${e.evidence}.`);
      break;
    }
    case 'heal': {
      // The factory's repair for a stranded record: settle stale findings, then queue the one thing that moves it.
      if (!stranded(w, ctx.now)) fail(`${w.id} isn't stranded.`);
      for (const f of w.findings) if (f.status === 'open' && ['ci', 'conflict'].includes(f.source?.type) && !sameSha(f.source.head, w.head))
        Object.assign(f, { status: 'resolved', note: `Superseded: the head is now ${w.head.slice(0, 7)}.`, at: ctx.now });
      const open = w.findings.some(f => f.status === 'open');
      const clean = w.reviews.some(r => sameSha(r.head, w.head) && r.result === 'clean') || capped(w, ctx);
      if (open) { w.phase = 'fixes'; w.approvalWait = null; requestFixes(w, ctx); note(w, ctx, `Stranded (nothing live or pending): fixes requested for the open findings.`); }
      else if (clean && gate(w, ctx).ok && e.isDraft === false) enterApprovalWait(w, ctx, `healed: clean review at ${w.head}, PR marked ready`);
      // A ready PR is waived from internal review (Alex's standing waiver), so heal doesn't ask for one.
      else if (e.isDraft === false && ctx.now >= HEAL_WAIVER_FROM && ctx.now < REVIEW_CAP_FROM && (w.internalReviewWaivers || []).some(x => sameSha(x.head, w.head) && x.prUrl === w.links?.pr)) enterApprovalWait(w, ctx, `healed: PR marked ready, review waived at ${w.head}`);
      else if (clean && gate(w, ctx).ok) { w.phase = 'ready_for_human'; note(w, ctx, `Stranded: back to ready for human, clean review at ${w.head}.`); }
      else { w.phase = 'rereview'; w.requests.push({ id: nextId(w.requests, 'R'), type: 'review', at: ctx.now, by: ctx.by, delivery: 'pending', ack: null, head: w.head }); note(w, ctx, `Stranded (nothing live or pending): review requested at ${w.head}.`); }
      break;
    }
    case 'request_review': {
      // Refreshes the review request at the current head when work finished without one; never a review itself.
      if (!REVIEWING.includes(w.phase) || !w.head) fail(`${w.id} isn't waiting for review at a known head.`);
      if (w.requests.some(r => r.type === 'review' && sameSha(r.head, w.head))) fail(`A review request at ${w.head} is already recorded.`);
      if (!e.evidence) fail('request_review needs evidence.');
      w.requests.push({ id: nextId(w.requests, 'R'), type: 'review', at: ctx.now, by: ctx.by, delivery: 'pending', ack: null, head: w.head });
      note(w, ctx, `Review requested at ${w.head}. Evidence: ${e.evidence}.`);
      break;
    }
    case 'proposal':
      w.proposal = { prompted: e.prompted, addresses: e.addresses, whyThisFix: e.whyThisFix, since: e.since, customerImpact: e.customerImpact, by: ctx.by, at: ctx.now };
      note(w, ctx, `New-PR breakdown recorded by ${ctx.by}.`);
      break;
    case 'pr_approved': {
      if (w.links?.pr) fail(`${w.id} already has its PR.`);
      if (w.prApproval) fail(`${w.id} is already approved by ${w.prApproval.by}.`);
      w.prApproval = { by: ctx.by, at: ctx.now };
      note(w, ctx, `${ctx.by} approved opening a new PR for this.`);
      break;
    }
    case 'withdraw': {
      // Work that shouldn't be on the board at all (filed by mistake, or a rule moved it off), before anyone started it.
      if (!e.note) fail('Withdrawing needs the reason.');
      // Cancelled-only work with no PR left nothing behind to undo.
      const onlyCancelled = ctx.now >= WITHDRAW_CANCELLED_FROM && !w.links?.pr && (w.assignments || []).every(a => a.status === 'cancelled');
      // W-378: its own PR closed unmerged (GitHub, read at the close) and nothing running: the work went elsewhere.
      const prClosed = ctx.prState?.state === 'CLOSED' && ctx.prState.url === w.links?.pr && !(w.assignments || []).some(a => LIVE_ASSIGNMENT.includes(a.status));
      if (TERMINAL.includes(w.phase) || ((w.assignments || []).length && !onlyCancelled && !prClosed)) fail(`${w.id} has started or finished; it can't be withdrawn${w.links?.pr ? ` while ${w.links.pr} is open on GitHub` : ''}.`);
      w.phase = 'cancelled';
      // A duplicate's source key goes to the record it duplicates (W-365), as an absorb would.
      w.completion = { withdrawn: e.note, at: ctx.now, by: ctx.by, ...(e.duplicateOf && { absorbedInto: e.duplicateOf }) };
      note(w, ctx, `Withdrawn: ${e.note}`);
      break;
    }
    case 'absorb': {
      // A poller's placeholder for work another record already carries (its PR or task). Only before anyone started it.
      if (!e.into || e.into === w.id) fail('absorb needs the record that carries the work.');
      // A record already cancelled (a duplicate closed before W-365) can be absorbed after the fact to hand over its key.
      const closed = w.phase === 'cancelled' && !(w.assignments || []).some(a => LIVE_ASSIGNMENT.includes(a.status));
      if (!closed && (![...PRE_QUEUE, 'proposed'].includes(w.phase) || (w.assignments || []).length)) fail(`${w.id} has started; it can't be absorbed into ${e.into}.`);
      w.phase = 'cancelled';
      w.completion = { ...(closed ? w.completion : {}), absorbedInto: e.into, at: ctx.now, by: ctx.by };
      note(w, ctx, `Absorbed into ${e.into}, which carries this work.`);
      break;
    }
    case 'exit_report': {
      // The DoD exit report as a record of its run (evolution phase 1): work/assignment/version/attempt, kept structured;
      // the note carries the same prose old readers parse.
      const a = (w.assignments || []).find(x => x.id === e.assignmentId);
      const run = { work: w.id, assignment: e.assignmentId || null, version: e.version ?? a?.version ?? null, attempt: a ? (a.history || []).filter(h => h.status === 'started').length || 1 : null };
      const f = k => String(e[k] ?? '').trim();
      w.reports = [...(w.reports || []), { run, changed: f('changed'), proven: f('proven'), unverified: f('unverified'), risk: f('risk'), head: e.head || null, at: ctx.now, by: ctx.by }];
      note(w, ctx, `Exit report. Changed: ${f('changed')} Proven: ${f('proven')} Unverified: ${f('unverified')} Risk: ${f('risk')}`);
      break;
    }
    case 'reviewer_rerequested': {
      // W-426: the board re-requested a non-approving reviewer whose feedback is addressed; one per review round.
      w.rerequests = [...(w.rerequests || []), { reviewer: e.reviewer, reviewAt: e.reviewAt, head: e.head, at: ctx.now }];
      note(w, ctx, `Re-requested ${e.reviewer}'s review on ${String(e.head).slice(0, 7)}: their ${String(e.state || '').toLowerCase().replace('_', ' ')} review's threads are all resolved and the head has moved.`);
      break;
    }
    case 'relate': {
      // Two records for the same work (e.g. a Teamwork task and its PR-feedback record): linked, never merged.
      if (!e.to || e.to === w.id) fail('relate needs another record.');
      if (!(w.related || []).some(r => r.to === e.to)) w.related = [...(w.related || []), { to: e.to, kind: e.kind || 'same-work', evidence: e.evidence || null, at: ctx.now, by: ctx.by }];
      note(w, ctx, `Related to ${e.to} (${e.kind || 'same-work'})${e.evidence ? `: ${e.evidence}` : ''}.`);
      break;
    }
    case 'wait': {
      // Work that waits on someone outside this flow (e.g. a QA owner). Not an Alex decision, not done.
      if (e.clear) { if (!w.waitingOn) fail(`${w.id} isn't waiting on anyone.`); if (!e.evidence) fail('Clearing a wait needs evidence.'); note(w, ctx, `No longer waiting on ${w.waitingOn.who}. Evidence: ${e.evidence}.`); w.waitingOn = null; break; }
      if (!e.who || !e.what || !e.evidence) fail('A wait needs who, what and evidence.');
      w.waitingOn = { who: e.who, what: e.what, evidence: e.evidence, at: ctx.now, by: ctx.by, ...(e.actor ? { actor: e.actor } : {}) };
      note(w, ctx, `Waiting on ${e.who}: ${e.what}. Evidence: ${e.evidence}.`);
      break;
    }
    case 'hold': {
      if (e.questions?.length) {
        const add = e.questions.filter(q => !w.externalDeps.some(d => d.question === q));
        w.externalDeps = [...w.externalDeps, ...add.map(q => ({ ref: q, question: q, text: `Alex answers ${q}` }))];
        note(w, ctx, `Held until Alex answers ${e.questions.join(', ')}.`);
        break;
      }
      if (e.review || e.deferred) {
        const d = e.review ? { ref: `review ${e.review.by}`, review: e.review, text: `review by ${e.review.by} (${e.review.reviewer})` } : { ref: `deferred ${e.deferred}`, deferred: e.deferred, text: `deferred to ${e.deferred}` };
        if (!w.externalDeps.some(x => x.text === d.text)) w.externalDeps = [...w.externalDeps, d];
        note(w, ctx, `Held: ${d.text}.`);
        break;
      }
      if (!e.prs?.length) fail('A hold needs PRs.');
      const add = e.prs.filter(pr => !w.externalDeps.some(d => d.pr === pr));
      w.externalDeps = [...w.externalDeps, ...add.map(pr => ({ ref: pr, pr, text: `${pr} merges` }))];
      note(w, ctx, `Held until ${e.prs.join(', ')} merge${e.prs.length > 1 ? '' : 's'}.`);
      break;
    }
    case 'carries_out':
      if (!/^TB-\d+$/.test(e.question || '')) fail('carries_out names a question, TB-n.');
      w.carriesOut = [...new Set([...(w.carriesOut || []), e.question])];
      note(w, ctx, `Carries out Alex's answer to ${e.question}.`);
      break;
    case 'hold_released':
      // A settled free-text hold, cleared by whoever triages it (W-3: the board lead had no way to).
      if (e.text) { if (!w.externalDeps.some(d => (d.text || d.ref) === e.text)) fail(`${w.id} has no hold "${e.text}".`); w.externalDeps = w.externalDeps.filter(d => (d.text || d.ref) !== e.text); note(w, ctx, `Hold released: ${e.text}.`); break; }
      if (e.question) { w.externalDeps = w.externalDeps.filter(d => d.question !== e.question); note(w, ctx, `Alex answered ${e.question}, so its hold is released.`); break; }
      w.externalDeps = w.externalDeps.filter(d => d.pr !== e.pr);
      note(w, ctx, `${e.pr} merged, so its hold is released.`);
      break;
    case 'note':
      if (!e.text) fail('A note needs text.');
      note(w, ctx, e.text);
      break;
    default:
      fail(`Unknown event "${e.type}".`);
  }
  return { work: normalize(w, ctx), spawn };
}

/** A head seen by a poller. A new SHA invalidates evidence exactly like a reported one. */
// Work that passed internal review but changed before Alex marked it ready gets a re-review request, so its stream is told.
function requestRereview(w, ctx) {
  if (!ctx.now || !w.head || w.requests.some(r => r.type === 'review' && sameSha(r.head, w.head))) return;
  w.requests.push({ id: nextId(w.requests, 'R'), type: 'review', at: ctx.now, by: ctx.by || 'board', delivery: 'pending', ack: null, head: w.head });
  note(w, ctx, `Re-review requested at ${w.head}: the PR moved on.${ctx.now >= REVIEW_CAP_FROM ? '' : " If it's already marked ready, the standing waiver applies."}`);
}
export function observeHead(work, { sha, via, isDraft, ancestry }, ctx) {
  if (TERMINAL.includes(work.phase) || !sha) return work;
  const w = structuredClone(work);
  setHead(w, sha, ctx, via, ancestry);
  // A reviewed PR already marked ready stays waiting for approval at a descending commit.
  if (work.phase === 'awaiting_human_approval' && w.phase === 'awaiting_human_approval' && via === 'github' && isDraft === false && w.head !== work.head && capped(w, ctx) && gate(w, ctx).ok) enterApprovalWait(w, ctx, `new commit ${w.head} descends from the reviewed head; PR still marked ready`);
  // Internal review is only needed before a PR is marked ready (Alex). A new commit on one already marked ready keeps it
  // waiting for approval, under the standing waiver, at the new commit.
  else if (work.phase === 'awaiting_human_approval' && via === 'github' && isDraft === false && w.head !== work.head && ctx.standingWaiver && w.links?.pr && !(ctx.now >= REVIEW_CAP_FROM)) {
    w.internalReviewWaivers = [...(w.internalReviewWaivers || []), { ...ctx.standingWaiver, head: w.head, prUrl: w.links.pr, at: ctx.now, recordedBy: ctx.by, evidence: `GitHub shows the PR still marked ready at ${w.head}` }];
    w.phase = 'awaiting_human_approval';
    w.approvalWait = { head: w.head, prUrl: w.links.pr, at: ctx.now, by: ctx.by, evidence: 'standing waiver: new commit on a PR already marked ready', requiredApprovals: { qa: 1, dev: 1 } };
    note(w, ctx, `New commit ${w.head} on a PR already marked ready: still waiting for human review/approval (standing waiver; no internal review).`);
  }
  if (w.phase === 'awaiting_human_approval' && isDraft === true) {
    w.phase = 'rereview'; w.approvalWait = null;
    note(w, ctx, 'Approval wait invalidated: GitHub shows the PR as draft again. No approvals inferred.');
  }
  return normalize(w, ctx);
}

// Steps a worker follows before touching code, so a red build from main or a flake is noted, never "fixed" (Alex, 2026-11-02).
const HEALTH_TEXT = {
  conflict: head => `Conflicts with main at ${head.slice(0, 7)}. Merge origin/main into the branch (merge, never rebase or force push), resolve, run the specs for the files the conflict touched, push.`,
  ci: (head, failing) => `CI is red at ${head.slice(0, 7)}: ${failing.join(', ')}. Assess once for this commit before changing code. 1) Find the failing tests: GitHub Actions via gh run view --log-failed; CircleCI via the circleci MCP, read only (list_runs on the branch, list_run_workflows, list_workflow_jobs, list_job_tests on the failed job; never rerun or cancel), read by the supervisor and put in the brief when the worker can't reach it. 2) Re-run each failure once locally. 3) Passes locally: accept this finding as "flake: <test>". 4) Fails on origin/main too: accept it as "red on main: <test>" and change nothing. 5) Fails only on this branch: fix it red-first. Anything outside this PR's scope is a discovery, never a fix.`,
};
const FEEDBACK_TEXT = {
  changes_requested: rs => `Changes requested by ${rs.map(r => `${r.by} (${r.url})`).join(', ')}. Work the review round (review-round skill): verify each thread at the head, fix what's real red-first, post factual replies; resolving threads waits for Alex.`,
  threads: ts => `${ts.length} new unresolved review thread(s): ${ts.map(t => `${t.by} ${t.url}`).join('; ')}. Work them as a review round (review-round skill); resolving waits for Alex.`,
  comments: cs => `${cs.length} new comment(s) on the PR or its Teamwork task: ${cs.map(c => `${c.by} ${c.url}${c.text ? `: "${c.text}"` : ''}`).join('; ')}. Read each; fix what's real red-first, and answer factually where it asks something.`,
};
/** Feedback from people (and review bots) on a record's PR or task, as finding source types. */
export const FEEDBACK_TYPES = ['changes_requested', 'threads', 'comments'];
// Work waiting on review or on Alex goes back to fixes; work being built only gets the finding.
export const HEALTH_REOPENS = [...REVIEWING, 'ready_for_human', 'awaiting_human_approval'];

/** GitHub's merge and CI state at the record's head: one finding per problem per commit, so a red build is assessed once. */
export function observeHealth(work, { head, conflict, failing = [], changesRequested = [], threads = [], comments = [], mainGreen = null }, ctx) {
  const atHead = !!head && sameSha(head, work.head);
  if (TERMINAL.includes(work.phase) || !head || (!atHead && ctx.now < FEEDBACK_ANY_HEAD_FROM)) return work;
  if (!atHead) { conflict = false; failing = []; mainGreen = null; } // CI and conflicts are judged at the record's head only
  const seen = type => (work.findings || []).some(f => f.source?.type === type && sameSha(f.source.head, head));
  const fresh = [conflict && 'conflict', failing.length && 'ci'].filter(t => t && !seen(t));
  // Reviewer feedback (W-207) is news once per review and per thread, whatever the head.
  const told = new Set((work.findings || []).flatMap(f => f.source?.ids || []));
  const reviews = changesRequested.filter(r => !told.has(r.id)), newThreads = threads.filter(t => !told.has(t.id)), newComments = comments.filter(c => !told.has(c.id));
  // W-208: CI still red at a head whose failure was judged "red on main", and main is green now: merging main reruns CI.
  const redOnMain = (work.findings || []).some(f => f.source?.type === 'ci' && sameSha(f.source.head, head) && f.status === 'accepted' && /red on main/i.test(f.note || ''));
  const mergeMain = !!(mainGreen && failing.length && redOnMain && !(work.findings || []).some(f => f.source?.type === 'merge_main' && f.source.main === mainGreen));
  // W-445: a comments finding that holds only ids takes the comments' text when a read brings it.
  const byId = new Map(comments.filter(c => c.text).map(c => [c.id, c]));
  const unquoted = (work.findings || []).filter(f => f.status === 'open' && f.source?.type === 'comments' && !f.source.quoted && f.source.ids.some(id => byId.has(id)));
  if (!fresh.length && !reviews.length && !newThreads.length && !newComments.length && !mergeMain && !unquoted.length) return work;
  const w = structuredClone(work);
  for (const f of w.findings.filter(x => unquoted.some(u => u.id === x.id))) {
    f.text = FEEDBACK_TEXT.comments(f.source.ids.map(id => byId.get(id) || { by: 'comment', url: id }));
    f.source.quoted = true;
    note(w, ctx, `Finding ${f.id} now quotes its comments.`);
  }
  if (!fresh.length && !reviews.length && !newThreads.length && !newComments.length && !mergeMain) return w;
  if (mergeMain) w.findings.push({ id: nextId(w.findings, 'F'), text: `main is green again at ${mainGreen.slice(0, 7)}, and CI at ${head.slice(0, 7)} failed only on what was red on main. Merge origin/main into the branch (merge, never rebase or force push) and push, so CI reruns.`, severity: null, status: 'open', reviewHead: null, note: null, source: { type: 'merge_main', head, main: mainGreen } });
  for (const type of fresh) w.findings.push({ id: nextId(w.findings, 'F'), text: HEALTH_TEXT[type](head, failing), severity: null, status: 'open', reviewHead: null, note: null, source: { type, head } });
  if (reviews.length) w.findings.push({ id: nextId(w.findings, 'F'), text: FEEDBACK_TEXT.changes_requested(reviews), severity: null, status: 'open', reviewHead: null, note: null, source: { type: 'changes_requested', head, ids: reviews.map(r => r.id), at: ctx.now } });
  if (newComments.length) w.findings.push({ id: nextId(w.findings, 'F'), text: FEEDBACK_TEXT.comments(newComments), severity: null, status: 'open', reviewHead: null, note: null, source: { type: 'comments', head, ids: newComments.map(c => c.id), at: ctx.now, quoted: newComments.some(c => c.text) || undefined } });
  if (newThreads.length) w.findings.push({ id: nextId(w.findings, 'F'), text: FEEDBACK_TEXT.threads(newThreads), severity: null, status: 'open', reviewHead: null, note: null, source: { type: 'threads', head, ids: newThreads.map(t => t.id), at: ctx.now } });
  const said = [...fresh.map(t => t === 'ci' ? `CI red (${failing.join(', ')})` : 'conflicts with main'),
    ...(mergeMain ? ['main is green again: merge it in'] : []), ...(reviews.length ? [`changes requested by ${[...new Set(reviews.map(r => r.by))].join(', ')}`] : []), ...(newThreads.length ? [`${newThreads.length} new unresolved thread(s)`] : []), ...(newComments.length ? [`${newComments.length} new comment(s)`] : [])];
  note(w, ctx, `GitHub at ${head.slice(0, 7)}: ${said.join('; ')}.`);
  if (HEALTH_REOPENS.includes(w.phase)) {
    w.phase = 'fixes'; w.approvalWait = null;
    w.requests.push({ id: nextId(w.requests, 'R'), type: 'fixes', at: ctx.now, by: ctx.by || 'github', delivery: 'pending', ack: null, head: w.head });
  }
  return normalize(w, ctx);
}

/** The poller can no longer see the linked PR: a head it verified is no longer verified. Reported heads stand. */
export function unverifyHead(work, ctx) {
  if (work.headVerified?.via !== 'github') return work;
  const w = structuredClone(work);
  w.headVerified = null;
  note(w, ctx, 'GitHub no longer shows the linked PR; its head is unverified until someone reports it.');
  return normalize(w, ctx);
}

/** Only the request for this commit and work round may describe the current phase. */
/** PR work in fixes or review with nothing live and nothing pending: no seat will ever move it (W-149, W-160, W-138). */
// From here a request acked "received" is queued with its seat, not settled (W-216: the heal re-filed W-192 every 15 min).
const RECEIVED_PENDING_FROM = '2026-11-06T01:00:00.000Z';
/**
 * Feedback that got past our internal review: a feedback finding raised while the record's latest internal review (by
 * time) was clean. Derived, never stored. ponytail: per reviewer, not per lens; reviews don't record a lens yet.
 */
export function escapes(w) {
  const reviews = (w.reviews || []).filter(r => r.at && !r.forAlex);
  return (w.findings || []).filter(f => FEEDBACK_TYPES.includes(f.source?.type) && f.source.at).flatMap(f => {
    const last = reviews.filter(r => r.at <= f.source.at).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    return last?.result === 'clean' ? [{ work: w.id, pr: w.links?.pr || null, finding: f.id, type: f.source.type, at: f.source.at, review: last.by, reviewHead: last.head }] : [];
  });
}

export function stranded(w, now) {
  if (!['fixes', ...REVIEWING].includes(w.phase) || !prLinked(w) || liveAssignment(w)) return false;
  // Under the cap a fixes round's findings wait on the supervisor's settle_finding, not on another seat.
  const open = w.findings.filter(f => f.status === 'open');
  if (capped(w, { now }) && open.length && open.every(f => f.reviewHead)) return false;
  const r = phaseRequest(w);
  // A clean review at the head after a "received" ack means the round needed no commit (W-249): nothing is pending.
  const settled = r?.ack?.outcome === 'received' && w.reviews.some(v => v.result === 'clean' && sameSha(v.head, w.head) && v.at > r.ack.at);
  return !r || !!r.ack && (settled || !(r.ack.outcome === 'received' && (now || '') >= RECEIVED_PENDING_FROM));
}

export function phaseRequest(w) {
  const type = { review: 'review', rereview: 'review', fixes: 'fixes' }[w.phase];
  if (!type || !w.head) return null;
  const round = [...(w.assignments || [])].reverse().find(a => BUILDING.includes(a.kind) && !a.noChange && !['cancelled', 'superseded'].includes(a.status));
  return [...w.requests].reverse().find(r => r.type === type && sameSha(r.head, w.head)
    && (r.assignment ? r.assignment === round?.id : !round?.at || (r.at && r.at > round.at))) || null;
}

const laneOf = a => (a.kind === 'review' ? 'review' : 'work');
const liveAssignment = (w, lane) => [...(w.assignments || [])].reverse().find(x => LIVE_ASSIGNMENT.includes(x.status) && (!lane || laneOf(x) === lane)) || null;
function enterApprovalWait(w, ctx, evidence) {
  w.phase = 'awaiting_human_approval';
  w.approvalWait = { head: w.head, prUrl: w.links.pr, at: ctx.now, by: ctx.by, evidence, requiredApprovals: { qa: 1, dev: 1 } };
  note(w, ctx, `PR observed ready at ${w.head}; waiting for human review/approval (1 QA + 1 dev). No GitHub approval, merge, deployment or Teamwork completion is recorded.`);
}
// ponytail: one rule date, so rows decided before W-184 replay as decided; snapshots or reducer versions if these pile up.
const NO_CHANGE_MOVES_ON = '2026-11-04T23:10:00.000Z';
// W-208: stale CI/conflict findings close on a head move, and a no-change round left in fixes queues its request.
const FINDINGS_FOLLOW_HEAD_FROM = '2026-11-05T22:00:00.000Z';
// W-149: a no-change round answers review threads and change requests too (the worker replied instead of changing code).
const FEEDBACK_NO_CHANGE_FROM = '2026-11-05T22:30:00.000Z';
// W-210: a clean review settles open review findings recorded at its own head as well as earlier ones.
const SAME_HEAD_CLEAN_FROM = '2026-11-05T22:45:00.000Z';
// From here reviewer feedback lands even before the record learns GitHub's newer head (#8640 waited on its report).
const WITHDRAW_CANCELLED_FROM = '2026-11-09T22:00:00.000Z';
const FEEDBACK_ANY_HEAD_FROM = '2026-11-09T20:00:00.000Z';
const HEAL_WAIVER_FROM = '2026-11-06T21:18:00.000Z';
const DECLINE_SETTLES_FROM = '2026-11-06T20:38:00.000Z';
/** Fixes with nothing pending strands a record: queue the request unless one is already open for this head. */
function requestFixes(w, ctx) {
  if (w.requests.some(r => r.type === 'fixes' && !r.ack && sameSha(r.head, w.head))) return;
  w.requests.push({ id: nextId(w.requests, 'R'), type: 'fixes', at: ctx.now, by: ctx.by, delivery: 'pending', ack: null, head: w.head });
}
function legacyNoChangePhase(w, a, ctx, baseline, remote) {
  if (!liveAssignment(w)) {
    if (baseline.phase === 'awaiting_human_approval') {
      const candidate = normalize({ ...w, phase: 'awaiting_human_approval' }, ctx);
      const canResume = remote.isDraft === false && !w.findings.some(f => f.status === 'open') && candidate.phase === 'awaiting_human_approval';
      w.phase = canResume ? 'awaiting_human_approval' : w.findings.some(f => f.status === 'open') ? 'fixes' : 'rereview';
      if (!canResume) w.approvalWait = null;
    } else w.phase = ['review', 'rereview', 'ready_for_human', 'fixes'].includes(baseline.phase) ? baseline.phase : 'rereview';
  }
  note(w, ctx, `No-change assignment ${a.id} finished at unchanged ${remote.head}; PR work remains ${w.phase}. Existing review/approval requirements remain; no internal review requested.`);
}
function finishNoChangeProbe(w, a, ctx) {
  if (!['implementation', 'fixes', 'discovery'].includes(a.kind)) fail('A review assignment cannot be relabelled as a no-change probe.');
  const baseline = a.startedFrom || a.recordedFrom, remote = ctx.prState;
  if (!baseline?.head || !baseline.prUrl || baseline.prUrl !== w.links?.pr) fail('A PR no-change report needs its recorded assignment baseline and unchanged PR link.');
  if (!sameSha(baseline.head, a.noChange.verifiedOn) || !sameSha(baseline.head, w.head)) fail(`Assignment baseline ${baseline.head} changed; no-change needs an unchanged commit.`);
  if (!remote || remote.url !== w.links?.pr || remote.state !== 'OPEN' || !sameSha(remote.head, w.head)) fail('GitHub must freshly confirm the same open PR and unchanged head for a no-change report.');
  setHead(w, remote.head, ctx, 'github');
  a.noChange.verifiedOn = remote.head;
  // Finishing this check doesn't finish the PR or dispose of another assignment's work.
  if (!(ctx.now >= NO_CHANGE_MOVES_ON)) return legacyNoChangePhase(w, a, ctx, baseline, remote);
  // A red-CI round that changes nothing is the verdict the CI finding asks for (flake / red on main): accept it.
  const settles = ['ci', ...(ctx.now >= FEEDBACK_NO_CHANGE_FROM ? FEEDBACK_TYPES : [])];
  if (a.kind === 'fixes') for (const f of w.findings.filter(f => f.status === 'open' && settles.includes(f.source?.type) && sameSha(f.source.head, w.head)))
    Object.assign(f, { status: 'accepted', note: `No change (${a.id}): ${a.noChange.evidence}`, at: ctx.now });
  if (!liveAssignment(w)) {
    const open = w.findings.some(f => f.status === 'open');
    const waived = ctx.now < REVIEW_CAP_FROM && (w.internalReviewWaivers || []).some(x => sameSha(x.head, w.head) && x.prUrl === w.links?.pr);
    if (baseline.phase === 'awaiting_human_approval' && normalize({ ...w, phase: 'awaiting_human_approval' }, ctx).phase === 'awaiting_human_approval' && remote.isDraft === false && !open) w.phase = 'awaiting_human_approval';
    else if (!open && remote.isDraft === false && (waived || gate(w, ctx).ok)) enterApprovalWait(w, ctx, `no-change ${a.id} at ${remote.head}`);
    else if (open) { w.phase = 'fixes'; w.approvalWait = null; if (ctx.now >= FINDINGS_FOLLOW_HEAD_FROM) requestFixes(w, ctx); }
    else { w.approvalWait = null; w.phase = baseline.phase === 'ready_for_human' && gate(w, ctx).ok ? 'ready_for_human' : ['review', 'rereview'].includes(baseline.phase) ? baseline.phase : 'rereview'; if (w.phase !== 'ready_for_human') requestRereview(w, ctx); }
  }
  note(w, ctx, `No-change assignment ${a.id} finished at unchanged ${remote.head}; PR work is now ${w.phase}.`);
}
function closeNoChange(w, a, ctx, evidence, merged = false) {
  if ((prLinked(w) && !merged) || (w.coverage?.prs || []).some(p => p.state === 'OPEN')) fail('A PR/code deliverable must follow its review lifecycle; no-change cannot close it.');
  if (!['implementation', 'discovery'].includes(a.kind)) fail('Only a regular implementation/discovery check can close without a code review.');
  if (!a.noChange?.verifiedOn || !a.noChange?.evidence) fail('No-change completion needs verified commit and evidence.');
  if (liveAssignment(w)) fail('Another assignment is still active.');
  if (w.requests.some(r => !r.ack)) fail('A pending request must be acknowledged before no-change closure.');
  w.phase = 'done';
  w.completion = { kind: 'no-change', assignment: a.id, verifiedOn: a.noChange.verifiedOn, evidence, at: ctx.now, by: ctx.by };
  note(w, ctx, `Done with no code deliverable: ${a.noChange.verifiedOn}. Evidence: ${evidence}. No internal review requested; existing review history is preserved.`);
}
function currentAssignment(w, id, expectedVersion) {
  const a = (w.assignments || []).find(x => x.id === id);
  if (!a) fail(`${id} isn't the current assignment on ${w.id} (it isn't recorded here at all).`);
  if (['done', 'cancelled', 'superseded'].includes(a.status)) fail(`${id} is ${a.status}; it isn't the current assignment.`);
  const current = liveAssignment(w, laneOf(a));
  if (current?.id !== id) fail(`${id} isn't the current assignment (${current?.id || 'none'} is).`);
  if (expectedVersion === undefined || expectedVersion === null) fail(`Report ${id} with --expect-version (it's at version ${a.version}).`);
  if (Number(expectedVersion) !== a.version) fail(`${id} is at version ${a.version}, not ${expectedVersion}; re-read it before reporting.`);
  return a;
}
function startAssignment(w, a, ctx, bump = true) {
  // ctx.depPhase reads current records, so dependencies this same event added count; an unknown one stays open.
  const open = ctx.depPhase ? (w.deps || []).filter(d => !SATISFIES_DEPS.includes(ctx.depPhase(d))) : ctx.openDeps || [];
  if (open.length) fail(`${a.id} can't start: ${w.id} is waiting on ${open.join(', ')}.`);
  // --after is a worker slot: it clears once that record's worker reported done, before any review. Unknown = still busy.
  const busy = (a.after || []).filter(d => !['review', 'rereview', 'ready_for_human', 'awaiting_human_approval', 'done'].includes(ctx.depPhase?.(d)) && !ctx.depWorkerDone?.(d));
  if (busy.length) fail(`${a.id} can't start: it runs after ${busy.join(', ')}'s worker finishes.`);
  const running = (a.afterAssignments || []).filter(id => LIVE_ASSIGNMENT.includes(w.assignments.find(x => x.id === id)?.status));
  if (running.length) fail(`${a.id} can't start: it runs after ${running.join(', ')} ends.`);
  a.history.push({ status: a.status, at: ctx.now, by: ctx.by });
  a.startedFrom ??= { phase: w.phase, head: w.head, prUrl: w.links?.pr || null };
  a.status = 'started'; if (bump) a.version++;
  if (a.kind === 'fixes') w.phase = 'fixes';
  if (a.kind === 'implementation') { w.phase = 'implementation'; w.implementer = a.owner || w.owner; }
  if (a.owner && takesOwner(a)) w.owner = a.owner;
  note(w, ctx, `Assignment ${a.id} started${a.owner ? ` by ${a.owner}` : ''}.`);
}

/** Before work is queued, its phase follows triage: open questions mean clarification, a clean verdict means ready. */
export function syncIntake(work, { bucket, openQuestions }) {
  // A proposed record (a worker's discovery) is triaged like intake.
  if (![...PRE_QUEUE, 'proposed'].includes(work.phase) || work.reconciled || COVERAGE_BLOCKS_QUEUE.includes(work.coverage?.state)) return work;
  const phase = openQuestions > 0 || bucket === 'clarify' && openQuestions > 0 ? 'clarification'
    : bucket === 'ready' || bucket === 'clarify' ? 'ready' : 'intake';
  return phase === work.phase ? work : { ...work, phase };
}

const kindOf = key => /^tw-/.test(key) ? 'build' : 'pr-feedback';

/** Additive, idempotent upgrade of a pre-work-record state file. Never rewrites an existing field. */
export function migrate(state, now) {
  state.work ??= {};
  state.workBySource ??= {};
  state.nextWork ??= 1;
  for (const key of Object.keys(state.items || {})) {
    if (state.workBySource[key]) continue;
    const id = `W-${state.nextWork++}`;
    state.work[id] = createWork({ id, title: key, kind: kindOf(key), source: { type: /^tw-/.test(key) ? 'teamwork' : 'pr', key } },
      { now: state.items[key].firstSeen || now, by: 'migration' });
    state.workBySource[key] = id;
  }
  for (const q of Object.values(state.questions || {})) if (q.item && !q.work && state.workBySource[q.item]) q.work = state.workBySource[q.item];
  // Fields added after the first upgrade; records written before them get empty defaults.
  for (const w of Object.values(state.work)) {
    w.prReadyOps ??= []; w.prReadyAuth ??= null; w.headVerified ??= null; w.requiredChecks ??= []; w.synthetic ??= false;
    w.externalDeps ??= []; w.aliases ??= []; w.reconciled ??= null; w.retro ??= null; w.coverage ??= null; w.related ??= []; w.assignments ??= []; w.waitingOn ??= null;
  }
  // Auto-triage questions are unverified until a person or the head says they're real; agent questions start verified.
  for (const q of Object.values(state.questions || {})) {
    if (q.verification) continue;
    q.verification = q.source === 'inbox' ? 'verified' : 'unverified';
    q.verificationSource = 'migration-default';
  }
  state.schema = 2;
  return state;
}

/** Why the PR must not be marked ready on GitHub now. `remote` is a fresh read: {head, isDraft}. */
export function prReadyPreflight(w, remote, ctx = {}) {
  const r = [];
  if (w.phase !== 'ready_for_human') r.push(`${w.id} is ${w.phase}, not ready for review.`);
  const g = gate(w, ctx);
  if (!g.ok) r.push(...g.reasons);
  const a = w.prReadyAuth;
  if (!a) r.push('No per-item authorization to mark the PR ready.');
  else {
    if (a.prUrl !== w.links?.pr) r.push('The authorization names a different PR.');
    if (a.head !== w.head) r.push(`The authorization was for ${a.head}, but the head is ${w.head}.`);
  }
  if (!remote) r.push('Could not read the PR from GitHub just now.');
  else if (remote.head !== w.head) r.push(`GitHub shows ${remote.head}, but the board's head is ${w.head}.`);
  return r;
}
