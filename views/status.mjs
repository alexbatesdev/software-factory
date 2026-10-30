// One answer to "what state is this card in?": column, Needs me / triage / delivery, list view, label, waiting line
// and whether Run triage takes it. Every count, column and label on the page reads this; nothing recomputes it. Pure.
import * as W from '../core/work.mjs';
import { categoryOf } from './category.mjs';
import { waitingOn, lostAnswer, reachesAlex } from '../core/derive.mjs';

export const PHASE_LABEL = { proposed: 'Proposed', intake: 'Intake', clarification: 'Needs clarification', ready: 'Ready to start', queued: 'Queued', implementation: 'Being built', review: 'In review', fixes: 'Fixing review findings', rereview: 'Re-review', ready_for_human: 'Internal review passed', awaiting_human_approval: 'Waiting for review / approval', awaiting_alex_review: 'Alex to submit his review', done: 'Done', cancelled: 'Cancelled' };
// Until someone acknowledges the review or fixes request, the phase says "requested", not "in review".
const REQUESTED = { review: ['review', 'Review requested'], rereview: ['review', 'Re-review requested'], fixes: ['fixes', 'Fixes requested'] };

export const awaitingReview = w => W.REVIEWING.includes(w.phase) && !w.reviews.some(r => r.head === w.head);
// PR feedback the poller no longer sees (resolved, or the PR closed) that nobody reconciled: history, not a queue candidate.
export const staleFeedback = w => w.source?.type === 'pr' && w.upstream === 'gone' && W.PRE_QUEUE.includes(w.phase) && !w.reconciled;
// Only coverage nobody has assessed needs triage; partial or none is an assessment with known work left.
const UNCOVERED = ['unknown'];

function needsOf(w, open) {
  // ready_for_human reaches Alex only when the board's own PR-ready attempt needs a person (derive.mjs waitingOn).
  const me = open.some(reachesAlex) || w.phase === 'awaiting_alex_review' || !!w.paneBlocked || (w.phase === 'ready_for_human' && waitingOn(w, { questions: [] })?.who === 'you');
  const stale = (w.staleReports || []).at(-1);
  // An open PR's feedback lane covers the task; closed work only resurfaces if its source changed.
  const closed = W.TERMINAL.includes(w.phase), covered = w.coverage?.state === 'open-pr';
  // A recorded wait or an open PR with no feedback isn't triage work. A held item stays, so it can be released there.
  const parked = !!w.waitingOn || (w.source?.type === 'pr' && w.upstream === 'gone');
  const triage = !parked && (!!w.sourceChangedAfterClose || (!closed && !!w.coverage?.stale) || (!closed && !covered && (open.some(q => !reachesAlex(q)) || (w.phase === 'intake' && !w.reconciled)
    || UNCOVERED.includes(w.coverage?.state)))
    || (!!stale && stale.current === w.head && !w.reviews.some(r => r.head === w.head && r.at > stale.at)));
  const bad = x => ['failed', 'uncertain'].includes(x);
  const delivery = w.requests.some(r => !r.ack && (bad(r.delivery) || bad(r.notify?.status)));
  return { me, triage, delivery };
}

function labelOf(w, view) {
  if (view === 'next' && w.currentAssignment?.status === 'queued') return `Queued for ${w.currentAssignment.kind} · ${w.currentAssignment.id}`;
  const [type, label] = REQUESTED[w.phase] || [];
  const active = (w.liveAssignments || []).find(a => ['started', 'blocked'].includes(a.status));
  if (active) return active.status === 'blocked' ? `Blocked · ${active.id}` : active.kind === 'review' ? `Independent review running · ${active.id}` : PHASE_LABEL[w.phase] || w.phase;
  const r = w.phaseRequest;
  if (type === 'review' && w.reviews.some(x => x.head === w.head)) return PHASE_LABEL[w.phase];
  if (r && !r.ack) return `${label} · ${r.delivery === 'written' ? 'supervisor not notified' : r.delivery}`;
  if (w.retro) return `Closed retrospectively (${w.retro.outcome})`;
  if (view === 'inactive') return 'No open review feedback (historical)';
  if (w.waitingOn && W.PRE_QUEUE.includes(w.phase)) return `Waiting on ${w.waitingOn.who}`;
  if (UNCOVERED.includes(w.coverage?.state) && W.PRE_QUEUE.includes(w.phase)) return `Coverage ${w.coverage.state}: needs triage`;
  if (w.coverage?.state === 'open-pr' && ![...W.ACTIVE, ...W.TERMINAL].includes(w.phase))
    return `PR open, awaiting next step${w.coverage.prs?.length ? ` · ${w.coverage.prs.map(p => `#${p.url.split('/pull/')[1]}${p.isDraft ? ' draft' : ''}`).join(', ')}` : ''}`;
  if (w.awaitingReview && r?.ack) return `Review request ${r.ack.outcome} by ${r.ack.by}; review not started`;
  return w.awaitingReview ? w.phase === 'rereview' ? 'Awaiting independent re-review' : 'Awaiting independent review' : PHASE_LABEL[w.phase] || w.phase;
}

/**
 * @param w the record's base view (openDeps, route, currentAssignment, liveAssignments, phaseRequest, awaitingReview, intakeHold)
 * @param ctx {questions: this record's questions, every status; rec: its item intent; item: its observed item; held}
 */
export function statusOf(w, { questions = [], rec = {}, item = null, held = false, group = {} } = {}) {
  const open = questions.filter(q => q.status === 'open');
  const needs = needsOf(w, open);
  if (lostAnswer(w, questions)) needs.me = true;
  const c = categoryOf({ rec, work: w, item, group, questions: questions.filter(q => q.status !== 'superseded') });
  // The list a record shows in follows its column; only feedback nobody reconciled, with no live column, reads as historical.
  const view = { progress: 'progress', prreview: 'prreview', ready: 'next' }[c.category] || (staleFeedback(w) ? 'inactive' : null);
  // Run triage takes a record only when it needs triage and nobody else is answering for it.
  const triageSkip = !needs.triage || needs.me ? null : held ? 'held untriaged by Alex' : !W.PRE_QUEUE.includes(w.phase) ? `${w.phase}, past triage`
    : w.stream ? `owned by ${w.stream}; its supervisor handles it` : null;
  // A PR unit with no lifecycle of its own (the poll just made its record) shows where its lead task is: the lifecycle
  // was recorded on that task, so it's the one source. A unit with its own phase, assignments or reviews keeps its own.
  const hollow = group.isUnit && group.lead && W.PRE_QUEUE.includes(w.phase) && !(w.assignments || []).length && !(w.reviews || []).length;
  const label = hollow ? `${group.lead.label} · ${group.lead.id}` : labelOf(w, view);
  const waiting = hollow ? (group.lead.waiting ? { ...group.lead.waiting, text: `${group.lead.id}: ${group.lead.waiting.text}` } : null) : waitingOn(w, { questions });
  return { needs, view, label, waiting, category: c.category, categoryReason: c.reason, categoryDerived: c.derived,
    triageable: needs.triage && !needs.me && !triageSkip, triageSkip };
}
