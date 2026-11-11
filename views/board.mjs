// The board as cards: each record's status, label, waiting line and column, computed from the log's state. Read-only.
import * as W from '../core/work.mjs';
import { routeOf, streamHold } from '../core/notifier.mjs';
import { sourceIndex } from '../core/correlate.mjs';
import { isPrUnit, groupIndex } from '../core/units.mjs';
import { statusOf, awaitingReview, PHASE_LABEL } from './status.mjs';
import { supportOf, prGateView } from '../core/store.mjs';

// Who a card waits on decides its section. Agents (seats, triage, reviewer panes) are the factory.
const AGENT = /^(sup|sbx): |^triage$|^trusted-review|^questions router$|^board lead$|^local-head$|^factory$|^triage board worker$|^agent-unblocker$|^board$/;
// The one place a card's section is decided (W-317): support on top, then Alex's action, another person, Parked only when nobody is named.
export const sectionOf = c => c.support && c.category !== 'history' ? 'support'
  : c.category === 'history' ? 'done'
  : c.heldOn || c.needs?.me || c.waiting?.who === 'you' ? 'you'
  : c.mergeReady ? 'merge'
  : c.waiting?.who && !AGENT.test(c.waiting.who) ? 'others'
  : c.category === 'parked' ? 'parked' : 'factory';

// The "Unverified:" part of the newest DoD exit report note (core/api.mjs writes it), unless it says nothing.
function unverifiedOf(w) {
  const note = [...(w.updates || [])].reverse().find(u => /^Exit report\./.test(u.text || ''));
  const m = note?.text.match(/Unverified: (.*?) Risk: /s)?.[1].trim();
  return m && !/^nothing\W*$/i.test(m) ? m : null;
}

// Delivery facts the status code reads from V1 record fields now come from inbox messages (one source: the messages).
function withDelivery(state, w, questions) {
  const open = Object.values(state.messages).filter(m => !m.ackedAt);
  const qs = questions.map(q => {
    const m = open.find(x => [x.about?.answers].flat().includes(q.id));
    return m && q.status === 'answered' && !q.answer?.ack ? { ...q, answer: { ...q.answer, sentTo: m.to, ackAsked: true } } : q;
  });
  // The newest stop notice for a still-started assignment that hasn't changed since; any later report clears it (as in V1).
  const stops = open.filter(m => m.work === w.id && m.about?.workerStop).reverse();
  for (const m of stops) {
    const a = (w.assignments || []).find(x => `${w.id}/${x.id}` === m.about.workerStop);
    if (a?.status === 'started' && !((a.history || []).at(-1)?.at > m.at)) return { questions: qs, workerStop: { to: m.to, assignment: a.id, version: a.version, notifiedAt: m.at } };
  }
  return { questions: qs, workerStop: w.workerStop };
}

/**
 * @param opts {supervisors, units: fleet units, prs: Map(url → {state, isDraft}) from the last GitHub read,
 *   idleSince: {unitId: ms} when each free stream's idle-queue wait began, graceMs before the board wakes it,
 *   queue: the last auto-dispatch plan [{id, action, reason}], in queue order}
 * @returns [{id, title, kind, phase, phaseLabel, stream, pr, label, waiting, category, needs, updatedAt, project, running, queue}] for every record
 */
// A click waiting in the Approvals side panel: noted on the card, never a Needs-you wait (Alex, 11-09).
function approvalNote(w, state, prApproval) {
  const rt = Object.values(state.threads || {}).filter(t => t.work === w.id && t.status !== 'resolved').length;
  if (rt) return `resolve ${rt} review thread${rt > 1 ? 's' : ''}`;
  return W.awaitsPrApproval(prGateView(state, w), prApproval) ? 'approve opening a new PR' : null;
}

const MERGE_STATE = { DIRTY: 'merge conflicts', BEHIND: 'behind main', BLOCKED: 'failing or pending checks', UNSTABLE: 'failing or pending checks', DRAFT: 'still a draft' };
// The one readiness check (W-318): the first gate an APPROVED PR misses, or null. An unread field is a miss, never a pass.
function mergeMiss(w, pr, stale) {
  if (stale) return stale;
  const coming = (w.assignments || []).find(a => ['queued', 'started'].includes(a.status));
  if (pr.state !== 'OPEN') return pr.state ? `PR is ${pr.state.toLowerCase()}` : 'PR state not read yet';
  if (pr.isDraft) return 'still a draft';
  if (!pr.approvals || !pr.head) return 'approval commits not read yet';
  if (!pr.base) return 'base branch not read yet';
  if (pr.base !== 'main') return `stacked on ${pr.base}`;
  if (!pr.mergeState) return 'merge state not read yet';
  if (pr.mergeState !== 'CLEAN') return MERGE_STATE[pr.mergeState] || `GitHub merge state ${pr.mergeState}`;
  if (pr.unresolvedThreads == null) return 'review threads not read yet';
  if (pr.unresolvedThreads) return `${pr.unresolvedThreads} unresolved review thread${pr.unresolvedThreads > 1 ? 's' : ''}`;
  return coming ? `a change is coming (${coming.id})` : null;
}

// What a card waits on when a person must act: Alex's decisions first, then a ready PR's approvals and merge.
function personWait(w, state, prs, stale) {
  const stated = [w.waitingOn && [w.waitingOn.who, w.waitingOn.what, w.waitingOn.actor], ...(w.assignments || []).filter(a => a.status === 'blocked' && a.waitingOn).map(a => [a.waitingOn, `${a.id} is blocked`, a.waitingActor])].filter(Boolean);
  const onAlex = stated.find(x => x[2] === 'alex');
  if (onAlex) return { who: 'you', text: `Waiting on you: ${onAlex[1]} (${onAlex[0]})` };
  // Someone else's stated wait is the real one; the PR's approval state is only the fallback.
  if (w.waitingOn) return null;
  const pr = prs.get(w.links?.pr);
  const parkedOpen = w.phase === 'intake' && w.triage?.bucket === 'intake' && !(w.externalDeps || []).length && pr?.state === 'OPEN' && !pr.isDraft;
  if ((w.phase === 'awaiting_human_approval' || parkedOpen) && pr?.reviewDecision) {
    const n = `#${w.links.pr.split('/pull/')[1]}`, by = pr.approvedBy || [];
    if (pr.reviewDecision === 'APPROVED') {
      // GitHub keeps APPROVED after new commits here (stale reviews aren't dismissed); only approvals at the head count (W-321).
      const old = (pr.approvals || []).filter(a => a.commit !== pr.head);
      if (old.length) {
        const at = old[0].commit, i = (pr.recentCommits || []).indexOf(at), since = i < 0 ? 'more commits since' : `${pr.recentCommits.length - 1 - i} commit${pr.recentCommits.length - 2 - i ? 's' : ''} since`;
        return { who: 'reviewers', text: `Waiting for re-approval on ${n}: approved at ${at.slice(0, 7)} (${old.map(a => a.by).sort().join(', ')}), ${since}` };
      }
      const miss = mergeMiss(w, pr, stale);
      return miss ? { who: 'github', text: `GitHub reviews approved on ${n} (${by.join(', ')}); not mergeable yet: ${miss}` }
        : { who: 'github', ready: true, text: `Maybe mergeable: ${n} approved (${by.join(', ')}), checks clean, no open threads; not confirmed, final QA is yours` };
    }
    return { who: 'reviewers', text: `Waiting for approvals on ${n}${by.length ? ` (approved so far: ${by.join(', ')})` : ''}` };
  }
  return null;
}

export function boardView(state, { supervisors = [], units = [], prs = new Map(), idleSince = {}, graceMs = 300000, queue = [], prApproval, prsReadAt = null, now = Date.now(), githubOwner = null } = {}) {
  // A PR read older than three polls can't vouch for a merge (W-317): it never shows ready.
  const stale = prsReadAt && now - prsReadAt > 15 * 60000 ? `GitHub not read since ${new Date(prsReadAt).toISOString().slice(11, 16)}Z` : null;
  // Auto-dispatch decides why ready work waits; its reason is the card's waiting line, and its order is the queue.
  const forStream = queue.filter(p => !p.action && /busy/.test(p.reason));
  const queued = new Map(queue.filter(p => !p.action).map(p => [p.id, { reason: p.reason, position: forStream.indexOf(p) + 1 || null }]));
  const idx = Object.fromEntries(sourceIndex(state)), g = groupIndex(state.work, idx);
  const byWork = new Map();
  for (const [id, q] of Object.entries(state.questions)) {
    const w = q.work || idx[q.item];
    if (w) byWork.set(w, [...(byWork.get(w) || []), { id, ...q }]);
  }
  const unitOf = w => w.stream ? units.find(x => x.supervisor?.label === w.stream) : undefined;
  const hhmm = ms => { const t = new Date(ms); return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`; };
  const queueHold = w => {
    const u = w.stream && (w.assignments || []).some(a => a.status === 'queued') && unitOf(w);
    if (!u) return null;
    return streamHold(u, state.work) || (idleSince[u.id] ? `stream free; the board wakes ${w.stream} at ${hhmm(idleSince[u.id] + graceMs)}` : null);
  };
  // A stream pane parked at a prompt while its record runs: only a person can answer it.
  const paneBlocked = w => (w.assignments || []).some(a => a.status === 'started') && [unitOf(w)?.supervisor, unitOf(w)?.worker].find(a => a?.status === 'blocked')?.label || null;
  const inputs = w => {
    const { questions, workerStop } = withDelivery(state, w, byWork.get(w.id) || []);
    // A V2 triage verdict lives on the record; V1's lives on its legacy item.
    const legacy = state.legacy.items?.[w.source?.key] || {}, rec = w.triage ? { ...legacy, triage: w.triage } : legacy;
    const base = {
      ...w, workerStop, openQuestions: questions.filter(q => q.status === 'open').length,
      openDeps: (w.deps || []).filter(d => !W.SATISFIES_DEPS.includes(state.work[d]?.phase)),
      route: routeOf(w, supervisors), awaitingReview: awaitingReview(w), phaseRequest: W.phaseRequest(w),
      currentAssignment: [...(w.assignments || [])].reverse().find(a => W.LIVE_ASSIGNMENT.includes(a.status)) || null,
      liveAssignments: (w.assignments || []).filter(a => W.LIVE_ASSIGNMENT.includes(a.status)),
      intakeHold: rec.intakeHold || null, intakeHoldHistory: rec.intakeHoldHistory || [], paneBlocked: paneBlocked(w), queueHold: queueHold(w),
    };
    return [base, { questions, rec, held: !!rec.intakeHold }];
  };
  // A PR unit shows its lead task: the one an agent is working on, else the one furthest along (as V1's groupOf).
  const groupOf = w => {
    const isUnit = isPrUnit(w, idx);
    const inside = isUnit ? [...(g.members[w.id] || []), ...(g.children[w.id] || [])] : [];
    const active = inside.map(id => [id, (state.work[id]?.assignments || []).find(a => a.status === 'started')]).find(([, a]) => a);
    const order = id => (active?.[0] === id ? 100 : 0) + W.PHASES.indexOf(state.work[id]?.phase);
    const leadId = isUnit ? inside.filter(id => !W.TERMINAL.includes(state.work[id]?.phase)).sort((a, b) => order(b) - order(a))[0] : null;
    let lead = null;
    if (leadId) { const [b, c] = inputs(state.work[leadId]); const st = statusOf(b, { ...c, group: { units: [{ id: w.id, phase: w.phase }] } }); lead = { id: leadId, label: st.label, waiting: st.waiting }; }
    return { isUnit, lead, units: (g.unitsOf[w.id] || []).map(id => ({ id, phase: state.work[id].phase })), members: g.members[w.id] || [], children: g.children[w.id] || [],
      activeMember: active ? `${active[0]} ${active[1].id}` : null, pr: prs.get(w.links?.pr) || null };
  };
  return Object.values(state.work).map(w => {
    const [base, ctx] = inputs(w);
    const st = statusOf(base, { ...ctx, group: groupOf(w) });
    const q = queued.get(w.id), started = (w.assignments || []).find(a => a.status === 'started');
    // The scheduler is the authority on queue place; only a record-level stated wait outranks it.
    const person = personWait(w, state, prs, stale);
    if (person && st.waiting?.who !== 'you') st.waiting = person;
    else if (q && st.waiting?.who !== 'you' && !w.waitingOn) st.waiting = { who: 'factory', text: q.position ? `In queue, #${q.position}: the next free stream takes #1` : `Not dispatched: ${q.reason}` };
    // Held on Alex's open question: it waits on him, wherever its triage parked it.
    const pr = w.links?.pr, n = pr && `#${pr.split('/pull/')[1]}`;
    // W-375: a PR in Alex's own repo has no other reviewers; a closed PR is named; a PR another record is fixing waits on that fix.
    if (githubOwner && pr && w.phase === 'awaiting_human_approval' && !pr.includes(`github.com/${githubOwner}/`) && !w.waitingOn) st.waiting = { who: 'you', text: `Waiting on you: ${n} is in your own repo (${pr.split('/pull/')[0].split('github.com/')[1]}); review and merge it yourself` };
    if (prs.get(pr)?.state === 'CLOSED' && st.waiting && !/is closed/.test(st.waiting.text)) st.waiting = { ...st.waiting, text: `${st.waiting.text} (${n} is closed)` };
    const fixing = pr && !W.BUILDING.includes(w.phase) && Object.values(state.work).find(o => o.id !== w.id && o.links?.pr === pr && W.BUILDING.includes(o.phase));
    if (fixing && w.phase === 'awaiting_human_approval') st.waiting = { who: 'factory', text: `${n} is being fixed under ${fixing.id}` };
    const heldOn = (w.externalDeps || []).map(d => d.question).find(id => state.questions[id]?.status === 'open') || null;
    if (heldOn) st.waiting = { who: 'you', text: `Waiting on you: ${heldOn} (${state.questions[heldOn].title})` };
    const c = { id: w.id, title: w.title, kind: w.kind, running: started && !W.TERMINAL.includes(w.phase) ? { id: started.id, kind: started.kind, owner: started.owner } : null, queue: q || null, priority: w.priority === 1, phase: w.phase, phaseLabel: PHASE_LABEL[w.phase], stream: w.stream || null, pr: w.links?.pr || null,
      label: st.label, heldOn, approval: approvalNote(w, state, prApproval), waiting: st.waiting && { who: st.waiting.who, text: st.waiting.text }, mergeReady: !!st.waiting?.ready && st.category !== 'in-unit', category: st.category, needs: st.needs, unverified: unverifiedOf(w), updatedAt: w.updatedAt, project: w.project?.name || (w.kind === 'factory' ? 'Software factory' : null), support: supportOf(state, w.id), tuning: [w.model, w.effort && `effort ${w.effort}`].filter(Boolean).join(' · ') || null };
    return { ...c, section: sectionOf(c) };
  });
}
