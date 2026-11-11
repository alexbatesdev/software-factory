// What each role may do on the board. Role files (~/Code/.claude/agents) say how to behave; this table decides what is allowed.
export const ACTIONS = ['read', 'ack', 'assign', 'progress', 'done', 'review', 'await_approval', 'ask', 'answer', 'route', 'create', 'set_owner', 'message', 'prioritize', 'triage', 'absorb', 'resolve', 'verify', 'cancel', 'settle_finding', 'withdraw', 'resolve_thread', 'propose_task'];

export const ROLES = {
  'local-head': ['read', 'ack', 'answer', 'ask', 'create', 'assign', 'set_owner'],
  'questions-router': ['read', 'ack', 'route', 'create', 'set_owner'],
  'stream-supervisor': ['read', 'ack', 'assign', 'progress', 'done', 'review', 'await_approval', 'ask', 'cancel', 'resolve_thread', 'settle_finding', 'propose_task'],
  'board-lead': ['read', 'ack', 'create', 'set_owner', 'assign', 'progress', 'message', 'triage', 'ask', 'verify', 'cancel', 'propose_task'],
  'board-developer': ACTIONS,
  'trusted-reviewer': [], // PR review carve-out (Alex, 11-06): trusted reviews run off the board
  // A stream's sbx worker, on the sandbox port only. Its instructions come in its brief, not a role file.
  'sbx-worker': ['read', 'ack', 'progress'],
};

/** A trusted-review pane's label: `pr-<n>-trusted` (its role file) or `trusted-review-<n>` (older panes). */
export const isTrustedReviewSeat = label => /^(pr-\d+-trusted|trusted-review-\d+)$/.test(label || '');

// Narrower grants inside an action, keyed role → action → check on the command's arguments.
const ownAsk = (a, c) => { const id = a.withdraw || a.amend; return !id || (!!c.seat && c.questions?.[id]?.from === c.seat) || 'a seat withdraws or amends only questions it asked'; };
const noPin = a => !a.pin || 'only local-head pins a stream, on Alex\'s word';
const LIMITS = {
  'local-head': { ask: ownAsk, set_owner: a => !!a.pin || 'local-head only sets an owner to pin a stream on Alex\'s word' },
  'board-lead': { ask: (a, c) => !!a.amend && !a.withdraw || ownAsk(a, c), assign: a => a.status === 'queued' && !a.supersedes || 'the board lead only queues work', set_owner: noPin,
    progress: a => !a.assignmentId || 'the board lead adds notes; worker reports are the supervisor\'s',
    ack: (a, c) => /^M-\d+$/.test(a.ref || '') || (!!c.seat && c.questions?.[a.ref]?.from === c.seat) || 'the board lead acks only messages addressed to it, and answers to its own questions' },
  'stream-supervisor': { ask: ownAsk },
  'sbx-worker': { progress: a => !a.assignmentId || 'a worker adds notes (and its branch); its supervisor records the assignment\'s stages',
    ack: a => /^M-\d+$/.test(a.ref || '') || 'a worker acks only messages addressed to it' },
  'questions-router': { set_owner: noPin, ack: a => /^M-\d+$/.test(a.ref || '') || 'the questions router acks only messages addressed to it' },
};

/** Why `role` may not take `action` with these arguments; null when it may. */
/** @param ctx {seat, questions} for checks that depend on who is asking. */
export function refusal(role, action, args = {}, ctx = {}) {
  if (!ACTIONS.includes(action)) return `"${action}" is not a board action.`;
  if (!ROLES[role]) return `"${role}" is not a factory role.`;
  if (!ROLES[role].includes(action)) return `${role} may not ${action}.`;
  const why = LIMITS[role]?.[action]?.(args, ctx);
  return why === true || why === undefined ? null : `${role} may not ${action} here: ${why}.`;
}
