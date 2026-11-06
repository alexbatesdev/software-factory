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
  // A named branch is kept on the record, so the worker's PR joins it instead of becoming a record (W-180).
  assign: ({ work, branch, ...a }) => { need({ work, ...a }, 'work', 'assignmentId', 'kind', 'status'); return [...branchLink(work, branch), ev(work, { ...a, type: 'assign' })]; },
  progress: a => { need(a, 'work'); return [...branchLink(a.work, a.branch), ev(a.work, a.assignmentId ? { type: 'progress', assignmentId: a.assignmentId, expectedVersion: a.expectedVersion, stage: a.stage, waitingOn: a.waitingOn, text: a.text } : a.discovery ? { type: 'discovery', text: a.discovery, objective: a.text } : a.waitingOn === 'clear' ? { type: 'wait', clear: true, evidence: a.text } : a.waitingOn ? { type: 'wait', who: a.waitingOn, what: a.text || 'parked', evidence: a.text || a.waitingOn } : { type: 'note', text: a.text })]; },
  done: a => {
    need(a, 'work');
    const link = a.pr ? [{ kind: 'update', target: a.work, payload: { links: { pr: a.pr } } }] : [];
    return [...link, ev(a.work, a.assignmentId
      ? { type: 'assignment_done', assignmentId: a.assignmentId, expectedVersion: a.expectedVersion, head: a.head, ...(a.noChange ? { noChange: a.noChange } : {}) }
      : { type: 'implementation_done', head: a.head })];
  },
  review: a => { need(a, 'work', 'head', 'result'); return [ev(a.work, { type: 'review', head: a.head, result: a.result, by: a.by, link: a.link, findings: a.findings })]; },
  await_approval: a => { need(a, 'work'); return [ev(a.work, { type: 'await_approval', head: a.head, evidence: a.evidence, waiver: a.waiver })]; },
  ask: a => [{ kind: 'ask', payload: { title: a.title, options: a.options, recommend: a.recommend, work: a.work, promptedBy: a.promptedBy, why: a.why, ac: a.ac, recommendWhy: a.recommendWhy, item: a.item } }],
  answer: a => { need(a, 'id'); return [{ kind: 'answer', target: a.id, payload: { choice: a.choice, note: a.note } }]; },
  route: a => {
    need(a, 'id', 'to');
    return [{ kind: 'route', target: a.id, payload: { to: a.to, note: a.note } }, ...(a.setOwnerOf ? [setOwner({ work: a.setOwnerOf, owner: a.to })] : [])];
  },
  // A created record's source is the seat that created it; pollers' sources come only from observe_source.
  // Correlation and ownership (aliases, PR links, owner, parent) come only from their own commands, which check them.
  create: a => {
    const { pr, branch, ...links } = a.links || {};
    const keep = Object.fromEntries(['title', 'objective', 'kind', 'repo', 'priority', 'criteria', 'deps'].filter(k => a[k] !== undefined).map(k => [k, a[k]]));
    return [{ kind: 'create', payload: { ...keep, links, source: { type: 'agent', by: a.by }, ...(a.phase === 'proposed' ? { phase: 'proposed' } : {}) } }];
  },
  set_owner: a => { need(a, 'work', 'owner'); return [setOwner(a)]; },
  // Alex's "priority": priority 1 cuts in line behind running work; clearing it returns the default, 3.
  prioritize: a => { need(a, 'work'); return [{ kind: 'update', target: a.work, payload: { priority: a.on === false ? 3 : 1 } }]; },
  // Triage (Alex, 11-04; was V1's triage runs): an intake record is ready to queue, needs clarifying, or stays in intake.
  triage: a => {
    need(a, 'work', 'bucket');
    if (!['ready', 'clarify', 'intake'].includes(a.bucket)) fail('Triage a record ready, clarify or intake.');
    return [{ kind: 'sync_intake', target: a.work, payload: { bucket: a.bucket, note: a.note } }];
  },
  // Repair (board developer): a poller's duplicate record folds into the record that carries the work.
  absorb: a => { need(a, 'work', 'into'); return [ev(a.work, { type: 'absorb', into: a.into })]; },
  cancel: a => { need(a, 'work', 'assignmentId', 'evidence'); return [ev(a.work, { type: 'cancel_assignment', assignmentId: a.assignmentId, expectedVersion: a.expectedVersion, evidence: a.evidence })]; },
  settle_finding: a => { need(a, 'work', 'findingId', 'status', 'note'); if (!['resolved', 'accepted'].includes(a.status)) fail('A finding is settled as resolved or accepted.'); return [ev(a.work, { type: 'finding', findingId: a.findingId, status: a.status, note: a.note })]; },
  withdraw: a => { need(a, 'work', 'note'); return [ev(a.work, { type: 'withdraw', note: a.note })]; },
  resolve: a => { need(a, 'work', 'note'); return [ev(a.work, { type: 'resolve', note: a.note })]; },
  verify: a => { need(a, 'id', 'note'); return [{ kind: 'question_verify', target: a.id, payload: { keep: a.keep !== false, note: a.note } }]; },
  message: a => { need(a, 'to', 'text'); return [{ kind: 'message', payload: { to: a.to, work: a.work, about: a.about, text: a.text } }]; },
};
const branchLink = (work, branch) => branch ? [{ kind: 'update', target: work, payload: { links: { branch: String(branch).trim() } } }] : [];
// Owner and stream move together, so routing never sees one without the other.
function setOwner(a) { return { kind: 'update', target: a.work, payload: { owner: a.owner, stream: a.owner, ...(a.pin ? { streamPin: { by: a.pin } } : {}) } }; }

/** The log commands one action stands for. */
export function commandsFor(action, args = {}) {
  const cmds = (BUILD[action] || fail(`"${action}" can't be written; it is read-only or unknown.`))(args);
  // A retried call carries the same eventId, so each of its commands is applied once.
  return args.eventId ? cmds.map((c, i) => ({ ...c, eventId: `${args.eventId}#${i}` })) : cmds;
}
