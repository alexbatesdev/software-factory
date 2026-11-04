import { TERMINAL, BUILDING, REVIEWING } from '../core/work.mjs';
import { reachesAlex } from '../core/derive.mjs';
// The board column for an item: the work record's own state first, then genuinely open questions, then the
// classifier's (or a manual) bucket. The classifier verdict is never rewritten; it stays on the item as provenance.

/** @returns {{category: string, reason: string, derived: boolean}} derived = decided by record state, not a bucket */
export function categoryOf({ rec = {}, work = null, item = null, questions = [], group = {} }) {
  const state = (category, reason) => ({ category, reason, derived: true });
  if (work && TERMINAL.includes(work.phase)) return state('history', `${work.id} is ${work.phase}${work.retro ? ` (${work.retro.outcome}, retrospective)` : ''}.`);
  if (rec.intakeHold) return state('untriaged', `Held untriaged by ${rec.intakeHold.by}: ${rec.intakeHold.reason}`);
  if (work?.phase === 'intake' && work.triage?.bucket === 'intake') return state('parked', `Triaged as not factory work by ${work.triage.by}.`);
  if (work) {
    if (work.waitingOn) return state('waiting', `${work.id} waits on ${work.waitingOn.who}: ${work.waitingOn.what}.`);
    // In progress means an agent is working on it right now: a started assignment here, or on a member or child of this PR unit.
    const started = (work.assignments || []).find(a => a.status === 'started');
    if (started) return state('progress', `${work.id}: ${started.id} ${started.kind || ''} running.`.replace('  ', ' '));
    if (group.activeMember) return state('progress', `${work.id}: ${group.activeMember} running in this PR unit.`);
    const blocked = (work.assignments || []).find(a => a.status === 'blocked');
    if (blocked) return state('waiting', `${work.id}: ${blocked.id} is blocked.`);
    const unit = (group.units || []).find(u => !TERMINAL.includes(u.phase));
    if (unit) return state('in-unit', `Implemented in PR unit ${unit.id}; shown on its card.`);
    if (['ready_for_human', 'awaiting_alex_review'].includes(work.phase)) return state('human', `${work.id} is waiting on Alex.`);
    if ((work.assignments || []).some(a => a.status === 'queued')) return state('ready', `${work.id} has queued work, up next.`);
    const pr = group.pr;
    if ((pr?.state === 'OPEN' && pr.isDraft === false) || work.phase === 'awaiting_human_approval') return state('prreview', `${work.id}: PR open and ready, waiting on human review/approval.`);
    // Queued is a decision to build; phase `ready` is set when questions clear, so it falls through to the bucket rules.
    if (work.phase === 'queued') return state('ready', `${work.id} is queued.`);
    if ([...BUILDING, ...REVIEWING].includes(work.phase)) return state('waiting', `${work.id} is ${work.phase}, but no agent is working on it right now.`);
    if (pr?.state === 'OPEN' && pr.isDraft) return state('waiting', `${work.id}: draft PR, no agent working on it right now.`);
    // A recorded open PR that has since merged or closed is a scope check, not proof of work in progress.
    if (work.coverage?.state === 'open-pr' && work.coverage.stale) return { category: 'untriaged', reason: `${work.id}'s covering PR is no longer open (${(work.coverage.stale.states || []).join(', ')}); needs a scope check.`, derived: false };
    if (work.coverage?.state === 'open-pr') return state('prreview', `${work.id} is covered by an open PR; that isn't proof every requirement is met.`);
  }
  const classifier = rec.triage?.bucket || 'untriaged';
  const open = questions.filter(q => q.status === 'open');
  if (open.length) {
    const unverified = open.filter(q => !reachesAlex(q)).length;
    const bucket = ['clarify', 'rewrite'].includes(rec.bucket || classifier) ? rec.bucket || classifier : 'clarify';
    return { category: bucket, reason: `${open.length} open question(s)${unverified ? `, ${unverified} unverified` : ''}: ${open.map(q => q.id).join(', ')}.`, derived: false };
  }
  if (rec.bucket) return { category: rec.bucket, reason: 'Moved here by hand.', derived: false };
  // Questions settled elsewhere close the question, not the work: the old verdict needs a fresh look, never an automatic Ready.
  const settled = questions.filter(q => q.status === 'settled');
  if (settled.length) return { category: 'untriaged', reason: `Questions settled elsewhere (${settled.map(q => q.id).join(', ')}) close those questions, not the work; the ${classifier} verdict predates them, so it needs a fresh triage.`, derived: false };
  const answered = questions.filter(q => q.status === 'answered');
  if (classifier === 'clarify' && answered.length) return { category: 'ready', reason: `Alex answered ${answered.map(q => q.id).join(', ')}.`, derived: false };
  if (classifier === 'clarify') return { category: 'clarify', reason: 'The classifier asked for clarification but no question is recorded.', derived: false };
  return { category: classifier, reason: classifier === 'untriaged' ? 'Not classified yet.' : 'Classifier verdict.', derived: false };
}
