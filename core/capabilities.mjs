// What each role may do on the board. Role files (~/Code/.claude/agents) say how to behave; this table decides what is allowed.
export const ACTIONS = ['read', 'ack', 'assign', 'progress', 'done', 'review', 'await_approval', 'ask', 'answer', 'route', 'create', 'set_owner', 'message'];

export const ROLES = {
  'local-head': ['read', 'answer', 'ask', 'create', 'assign'],
  'questions-router': ['read', 'route', 'create', 'set_owner'],
  'stream-supervisor': ['read', 'ack', 'assign', 'progress', 'done', 'review', 'await_approval', 'ask'],
  'board-lead': ['read', 'create', 'set_owner', 'assign'],
  'board-developer': ACTIONS,
};

// Narrower grants inside an action, keyed role → action → check on the command's arguments.
const noPin = a => !a.pin || 'only local-head pins a stream, on Alex\'s word';
const LIMITS = {
  'board-lead': { assign: a => a.status === 'queued' && !a.supersedes || 'the board lead only queues work', set_owner: noPin },
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
