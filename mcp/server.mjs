// The board MCP server: one tool per board action the caller's role holds, over the factory API. Hand-rolled stdio JSON-RPC.
// The caller's seat is its herdr pane's label, so no tool takes a "by".
import { ACTIONS, ROLES } from '../core/capabilities.mjs';
import { roleOf } from '../core/api.mjs';
import { reachesAlex } from '../core/derive.mjs';

const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: true });
const str = description => ({ type: 'string', description });
// Read tools sit beside the 13 actions; `read` covers both.
const TOOLS = {
  inbox: ['Your unread factory messages. Ack each once handled.', obj({}), 'read'],
  read: ['A work record (work: W-n), a question in full (question: TB-n), or the whole board when neither is given.', obj({ work: str('W-n'), question: str('TB-n') }), 'read'],
  questions: ["Alex's open questions in full (options, recommendation, why, what prompted it), each with its record and project; all: true adds unverified ones.", obj({ all: { type: 'boolean' } }), 'read'],
  ack: ['Acknowledge a message (M-n), a request (W-n/R-n) or a delivered answer (TB-n).', obj({ ref: str('M-n, W-n/R-n or TB-n'), outcome: str('received | done | declined'), note: str('optional') }, ['ref']), 'ack'],
  assign: ['Record an assignment on a record.', obj({ work: str('W-n'), assignmentId: str('R-n'), kind: str('implementation | fixes | review | discovery'), status: str('queued | started | done'), owner: str('pane label'), evidence: str('why'), branch: str('the git branch the brief names: the worker\'s PR then joins this record instead of becoming a new one') }, ['work', 'assignmentId', 'kind', 'status']), 'assign'],
  progress: ['Relay a worker report, or add a note.', obj({ work: str('W-n'), assignmentId: str('R-n'), expectedVersion: { type: 'number' }, stage: str('started | working | blocked'), waitingOn: str('With an assignment (stage blocked): TB-n, W-n or a short text; parks the job and frees the stream, and a TB-n/W-n blocker resumes it when it clears. Without one: parks the record itself (who or what it waits on), so the idle nudge stops counting it; "clear" unparks it'), text: str('report'), branch: str('the git branch the worker builds on, if known: its PR then joins this record') }, ['work']), 'progress'],
  done: ['The worker finished: head SHA, optional PR URL; noChange for a check that found nothing to build.', obj({ work: str('W-n'), assignmentId: str('R-n'), expectedVersion: { type: 'number' }, head: str('SHA'), pr: str('PR URL'), noChange: obj({ verifiedOn: str('SHA'), evidence: str('why') }) }, ['work']), 'done'],
  review: ['Record an internal-review result at a head.', obj({ work: str('W-n'), head: str('SHA'), result: str('clean | findings'), by: str('reviewer label'), link: str('report path'), findings: { type: 'array' } }, ['work', 'head', 'result']), 'review'],
  await_approval: ['A PR already marked ready waits for human approval (standing waiver).', obj({ work: str('W-n'), head: str('SHA'), evidence: str('evidence'), waiver: { type: 'object' } }, ['work']), 'await_approval'],
  ask: ['File a question for Alex.', obj({ title: str('the question'), options: { type: 'array', items: obj({ key: str('a'), text: str('option') }) }, recommend: str('option key'), work: str('W-n'), promptedBy: str('who or what raised it, with a verbatim quote'), why: str('context Alex needs'), recommendWhy: str('why that option') }, ['title', 'promptedBy']), 'ask'],
  answer: ["Record Alex's answer to TB-n, as he gave it.", obj({ id: str('TB-n'), choice: str('option key or rec'), note: str("Alex's words") }, ['id']), 'answer'],
  route: ['Send an answer on to its owner; setOwner also makes them the record\'s owner.', obj({ id: str('TB-n'), to: str('seat label'), setOwner: { type: 'boolean' }, note: str('why') }, ['id', 'to']), 'route'],
  create: ['Create a work record.', obj({ title: str('title'), objective: str('objective'), kind: str('build | pr-feedback'), links: { type: 'object' } }, ['title']), 'create'],
  set_owner: ["Set a record's owner (its stream).", obj({ work: str('W-n'), owner: str('seat label'), pin: str("who pinned it (local-head, on Alex's word)") }, ['work', 'owner']), 'set_owner'],
  prioritize: ["Mark a record as Alex's priority (on: false clears it): it cuts in line behind whatever its stream is running.", obj({ work: str('W-n'), on: { type: 'boolean' } }, ['work']), 'prioritize'],
  triage: ['Triage an intake record: ready (queue it), clarify (a question is open) or intake (not yet).', obj({ work: str('W-n'), bucket: str('ready | clarify | intake'), note: str('why, one line') }, ['work', 'bucket']), 'triage'],
  absorb: ["Repair: fold a poller's duplicate record (not started) into the record that carries its work.", obj({ work: str('W-n, the duplicate'), into: str('W-n that carries the work') }, ['work', 'into']), 'absorb'],
  resolve: ['Close a record with no PR and no criteria (a factory fix, a manual chore) with a note on what settled it.', obj({ work: str('W-n'), note: str('commit or who did it') }, ['work', 'note']), 'resolve'],
  verify: ['Decide whether an unverified question (filed by V1 triage) should reach Alex: keep: true lets it through, false drops it. Note why.', obj({ id: str('TB-n'), keep: { type: 'boolean' }, note: str('why') }, ['id', 'note']), 'verify'],
  cancel: ['Cancel a stuck assignment (its pane is gone, its PR closed) with evidence; its history stays.', obj({ work: str('W-n'), assignmentId: str('R-n'), expectedVersion: { type: 'number' }, evidence: str('why it will never run') }, ['work', 'assignmentId', 'evidence']), 'cancel'],
  message: ['Send a seat a message on a record; the factory delivers it.', obj({ to: str('seat label'), text: str('message'), work: str('W-n') }, ['to', 'text']), 'message'],
};
for (const a of ACTIONS) if (!Object.values(TOOLS).some(t => t[2] === a)) throw new Error(`No MCP tool for board action ${a}.`);

/**
 * @param seatOf async () => the caller's seat label
 * @param api {get(path, seat), post(action, args, seat)}
 * @returns handle(message) → response or null (for notifications)
 */
export function createMcp({ config, seatOf, api }) {
  let seat;
  // Read every call: a pane relabelled mid-session (a seat rename) must act as its new seat.
  const mine = async () => { seat = await seatOf(); const role = roleOf(config, seat); return Object.entries(TOOLS).filter(([, t]) => role && ROLES[role].includes(t[2])); };
  const text = (body, isError = false) => ({ content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 1) }], isError });
  async function call(name, args = {}) {
    if (!(await mine()).some(([n]) => n === name)) return text(`${seat} has no ${name} tool.`, true);
    if (name === 'inbox') return text(await api.get('/api/inbox', seat));
    if (name === 'read') {
      const s = await api.get('/api/state', seat), q = args.question || (/^TB-\d+$/.test(args.work || '') ? args.work : null);
      if (q) return text(s.questions[q] ? { id: q, ...s.questions[q] } : `There is no ${q}.`);
      return text(args.work ? s.work[args.work] || `There is no ${args.work}.` : { work: Object.values(s.work).map(w => ({ id: w.id, title: w.title, phase: w.phase, stream: w.stream })) });
    }
    if (name === 'questions') {
      const s = await api.get('/api/state', seat);
      const open = Object.entries(s.questions).map(([id, q]) => ({ id, ...q })).filter(q => q.status === 'open' && (args.all || reachesAlex(q)));
      return text(open.map(q => { const w = s.work[q.work]; return { ...q, record: w ? { id: w.id, title: w.title, phase: w.phase, stream: w.stream || null, project: w.project?.name || null, pr: w.links?.pr || null } : null }; }));
    }
    const r = await api.post(name, args, seat);
    return text(r, !!r.error);
  }
  return async function handle(msg) {
    const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.id === undefined) return null;
    try {
      switch (msg.method) {
        case 'initialize': return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'software-factory', version: '0.1.0' } });
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: (await mine()).map(([name, [description, inputSchema]]) => ({ name, description, inputSchema })) });
        case 'tools/call': return reply(await call(msg.params?.name, msg.params?.arguments));
        default: return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } };
      }
    } catch (e) { return reply(text(e.message, true)); }
  };
}
