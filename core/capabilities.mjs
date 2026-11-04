// What each role may do on the board. Role files (~/Code/.claude/agents) say how to behave; this table decides what is allowed.
export const ACTIONS = ['read', 'ack', 'assign', 'progress', 'done', 'review', 'await_approval', 'ask', 'answer', 'route', 'create', 'set_owner', 'message', 'prioritize', 'triage'];

export const ROLES = {
  'local-head': ['read', 'ack', 'answer', 'ask', 'create', 'assign', 'set_owner'],
  'questions-router': ['read', 'route', 'create', 'set_owner'],
  'stream-supervisor': ['read', 'ack', 'assign', 'progress', 'done', 'review', 'await_approval', 'ask'],
  'board-lead': ['read', 'ack', 'create', 'set_owner', 'assign', 'progress', 'message', 'triage', 'ask'],
  'board-developer': ACTIONS,
};

// Narrower grants inside an action, keyed role → action → check on the command's arguments.
const noPin = a => !a.pin || 'only local-head pins a stream, on Alex\'s word';
const LIMITS = {
  'local-head': { set_owner: a => !!a.pin || 'local-head only sets an owner to pin a stream on Alex\'s word' },
  'board-lead': { assign: a => a.status === 'queued' && !a.supersedes || 'the board lead only queues work', set_owner: noPin,
    progress: a => !a.assignmentId || 'the board lead adds notes; worker reports are the supervisor\'s',
    ack: a => /^M-\d+$/.test(a.ref || '') || 'the board lead acks only messages addressed to it' },
  'questions-router': { set_owner: noPin },
};

/** Why `role` may not take `action` with these arguments; null when it may. */
export function refusal(role, action, args = {}) {
  if (!ACTIONS.includes(action)) return `"${action}" is not a board action.`;
  if (!ROLES[role]) return `"${role}" is not a factory role.`;
  if (!ROLES[role].includes(action)) return `${role} may not ${action}.`;
  const why = LIMITS[role]?.[action]?.(args);
  return why === true || why === undefined ? null : `${role} may not ${action} here: ${why}.`;
}
