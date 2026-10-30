// The board actions (capabilities.mjs) as log commands. Each action yields only its own command kinds and event types,
// so a role granted `progress` can't send an `await_approval` by naming it.
const fail = msg => { throw new Error(msg); };
const ev = (target, payload) => ({ kind: 'event', target, payload });
const need = (args, ...keys) => { for (const k of keys) if (args[k] === undefined || args[k] === '') fail(`Missing "${k}".`); };

const BUILD = {
  ack: a => {
    need(a, 'ref');
    if (/^TB-\d+$/.test(a.ref)) return [{ kind: 'question_ack', target: a.ref, payload: { outcome: a.outcome, note: a.note } }];
    if (/^M-\d+$/.test(a.ref)) return [{ kind: 'ack_message', target: a.ref, payload: { outcome: a.outcome } }];
    const [w, r] = a.ref.split('/');
    return [ev(w, { type: 'ack', requestId: r, outcome: a.outcome || 'received', note: a.note, by: a.by })];
  },
  assign: ({ work, ...a }) => { need({ work, ...a }, 'work', 'assignmentId', 'kind', 'status'); return [ev(work, { ...a, type: 'assign' })]; },
  progress: a => { need(a, 'work'); return [ev(a.work, a.assignmentId ? { type: 'progress', assignmentId: a.assignmentId, expectedVersion: a.expectedVersion, stage: a.stage, text: a.text } : { type: 'note', text: a.text })]; },
  done: a => {
    need(a, 'work');
    const link = a.pr ? [{ kind: 'update', target: a.work, payload: { links: { pr: a.pr } } }] : [];
    return [...link, ev(a.work, a.assignmentId
      ? { type: 'assignment_done', assignmentId: a.assignmentId, expectedVersion: a.expectedVersion, head: a.head, ...(a.noChange ? { noChange: a.noChange } : {}) }
      : { type: 'implementation_done', head: a.head })];
  },
  review: a => { need(a, 'work', 'head', 'result'); return [ev(a.work, { type: 'review', head: a.head, result: a.result, by: a.by, link: a.link, findings: a.findings })]; },
  await_approval: a => { need(a, 'work'); return [ev(a.work, { type: 'await_approval', head: a.head, evidence: a.evidence, waiver: a.waiver })]; },
  ask: a => [{ kind: 'ask', payload: { title: a.title, options: a.options, recommend: a.recommend, work: a.work } }],
  answer: a => { need(a, 'id'); return [{ kind: 'answer', target: a.id, payload: { choice: a.choice, note: a.note } }]; },
  route: a => {
    need(a, 'id', 'to');
    return [{ kind: 'route', target: a.id, payload: { to: a.to, note: a.note } }, ...(a.setOwnerOf ? [setOwner({ work: a.setOwnerOf, owner: a.to })] : [])];
  },
  create: a => [{ kind: 'create', payload: a }],
  set_owner: a => { need(a, 'work', 'owner'); return [setOwner(a)]; },
  message: a => { need(a, 'to', 'text'); return [{ kind: 'message', payload: { to: a.to, work: a.work, about: a.about, text: a.text } }]; },
};
// Owner and stream move together, so routing never sees one without the other.
function setOwner(a) { return { kind: 'update', target: a.work, payload: { owner: a.owner, stream: a.owner, ...(a.pin ? { streamPin: { by: a.pin } } : {}) } }; }

/** The log commands one action stands for. */
export function commandsFor(action, args = {}) {
  return (BUILD[action] || fail(`"${action}" can't be written; it is read-only or unknown.`))(args);
}
