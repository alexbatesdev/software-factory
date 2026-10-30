// The board as cards: each record's status, label, waiting line and column, computed from the log's state. Read-only.
import * as W from '../core/work.mjs';
import { routeOf, streamHold } from '../core/notifier.mjs';
import { sourceIndex } from '../core/correlate.mjs';
import { isPrUnit, groupIndex } from '../core/units.mjs';
import { statusOf, awaitingReview, PHASE_LABEL } from './status.mjs';

// Delivery facts the status code reads from V1 record fields now come from inbox messages (one source: the messages).
function withDelivery(state, w, questions) {
  const open = Object.values(state.messages).filter(m => !m.ackedAt);
  const qs = questions.map(q => {
    const m = open.find(x => [x.about?.answers].flat().includes(q.id));
    return m && q.status === 'answered' && !q.answer?.ack ? { ...q, answer: { ...q.answer, sentTo: m.to, ackAsked: true } } : q;
  });
  const stop = open.find(m => m.work === w.id && m.about?.workerStop);
  const a = stop && (w.assignments || []).find(x => `${w.id}/${x.id}` === stop.about.workerStop);
  return { questions: qs, workerStop: a ? { to: stop.to, assignment: a.id, version: a.version, notifiedAt: stop.at } : w.workerStop };
}

/**
 * @param opts {supervisors, units: fleet units (for "queued behind" holds), prs: Map(url → {state, isDraft}) from the last GitHub read}
 * @returns [{id, title, phase, phaseLabel, stream, pr, label, waiting, category, needs, updatedAt}] for every record
 */
export function boardView(state, { supervisors = [], units = [], prs = new Map() } = {}) {
  const idx = Object.fromEntries(sourceIndex(state)), g = groupIndex(state.work, idx);
  const byWork = new Map();
  for (const [id, q] of Object.entries(state.questions)) {
    const w = q.work || idx[q.item];
    if (w) byWork.set(w, [...(byWork.get(w) || []), { id, ...q }]);
  }
  const queueHold = w => {
    const u = w.stream && (w.assignments || []).some(a => a.status === 'queued') && units.find(x => x.supervisor?.label === w.stream);
    return u ? streamHold(u, state.work) : null;
  };
  const inputs = w => {
    const { questions, workerStop } = withDelivery(state, w, byWork.get(w.id) || []);
    const rec = state.legacy.items?.[w.source?.key] || {};
    const base = {
      ...w, workerStop, openQuestions: questions.filter(q => q.status === 'open').length,
      openDeps: (w.deps || []).filter(d => !W.SATISFIES_DEPS.includes(state.work[d]?.phase)),
      route: routeOf(w, supervisors), awaitingReview: awaitingReview(w), phaseRequest: W.phaseRequest(w),
      currentAssignment: [...(w.assignments || [])].reverse().find(a => W.LIVE_ASSIGNMENT.includes(a.status)) || null,
      liveAssignments: (w.assignments || []).filter(a => W.LIVE_ASSIGNMENT.includes(a.status)),
      intakeHold: rec.intakeHold || null, intakeHoldHistory: rec.intakeHoldHistory || [], paneBlocked: null, queueHold: queueHold(w),
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
    return { id: w.id, title: w.title, phase: w.phase, phaseLabel: PHASE_LABEL[w.phase], stream: w.stream || null, pr: w.links?.pr || null,
      label: st.label, waiting: st.waiting && { who: st.waiting.who, text: st.waiting.text }, category: st.category, needs: st.needs, updatedAt: w.updatedAt };
  });
}
