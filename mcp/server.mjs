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
  progress: ['Relay a worker report, or add a note.', obj({ work: str('W-n'), assignmentId: str('R-n'), expectedVersion: { type: 'number' }, stage: str('started | working | blocked'), waitingOn: str('With an assignment (stage blocked): TB-n, W-n, #N (a PR) or a short text with actor; parks the job and frees the stream, and a TB-n/W-n/PR blocker resumes it when it clears (a PR once it merges). Without one: parks the record itself (who or what it waits on), so the idle nudge stops counting it; "clear" unparks it'), actor: str('Required when waitingOn is text, not a TB-n/W-n/PR: "alex" when Alex must act (it shows in his Needs you), else "other". Never inferred from the text'), text: str('report'), discovery: str('An out-of-scope find, as the title of its own new record. text is required and becomes its objective: what is wrong and where (file:line), so it can be briefed on its own; never the reporting job\'s status. Use this, never a plain note, for anything that needs its own record'), branch: str('the git branch the worker builds on, if known: its PR then joins this record') }, ['work']), 'progress'],
  done: ['The worker finished: head SHA, optional PR URL; noChange for a check that found nothing to build.', obj({ report: { type: 'object', description: 'The worker\'s Definition of Done exit report, required for code work (not reviews or no-change): {changed, proven, unverified, risk}. Check it against ~/Code/plans/standards/DEFINITION_OF_DONE.md "Not done if" first.', properties: { changed: str('what changed'), proven: str('how it was proven: the observed evidence'), unverified: str('what was not verified and why, or "nothing"'), risk: str('residual risk and follow-ups') } }, work: str('W-n'), assignmentId: str('R-n'), expectedVersion: { type: 'number' }, head: str('SHA'), replacesPr: str('the PR this one replaces (Alex replaced it, e.g. a hotfix to production): it is unlinked first; must be the PR the record carries now'), pr: str('PR URL'), noChange: obj({ verifiedOn: str('SHA'), evidence: str('why') }) }, ['work']), 'done'],
  review: ['Record an internal-review result at a head.', obj({ work: str('W-n'), head: str('SHA'), from: str('Only for a record with no PR of its own: the head the review started at, when its fixes moved the head (the factory can\'t observe it)'), result: str('clean | findings'), by: str('reviewer label'), link: str('report path'), findings: { type: 'array' } }, ['work', 'head', 'result']), 'review'],
  await_approval: ['A PR whose internal review gate passed and that GitHub shows ready waits for human approval. No waivers from 2026-11-10.', obj({ work: str('W-n'), head: str('SHA'), evidence: str('evidence'), waiver: { type: 'object' } }, ['work']), 'await_approval'],
  ask: ['File a question for Alex (one open question per record unless distinct), add to an open one (amend), or withdraw one you asked.', obj({ wwbd: str('Required: the passage of ~/Code/plans/standards/WWBD.md you checked and why it doesn\'t settle this, or "no passage applies". If a passage settles it, act on it instead of asking.'), title: str('the question'), options: { type: 'array', items: obj({ key: str('a'), text: str('option') }) }, recommend: str('option key'), work: str('W-n'), promptedBy: str('who or what raised it, with a verbatim quote'), why: str('context Alex needs'), recommendWhy: str('why that option'), distinct: { type: 'boolean', description: 'true: a separate decision from the open question already on this record' }, withdraw: str('TB-n you asked, to withdraw it instead of asking (with note)'), amend: str('TB-n to add to instead of asking: appends note to the open question (its asker or the board lead)'), note: str('with withdraw: why; with amend: what to add') }, []), 'ask'],
  answer: ["Record Alex's answer to TB-n, as he gave it.", obj({ id: str('TB-n'), choice: str('option key or rec'), note: str("Alex's words") }, ['id']), 'answer'],
  route: ['Send an answer on to its owner; setOwner also makes them the record\'s owner.', obj({ id: str('TB-n'), to: str('seat label'), setOwner: { type: 'boolean' }, note: str('why') }, ['id', 'to']), 'route'],
  create: ['Create a work record.', obj({ title: str('title'), objective: str('objective'), kind: str('build | pr-feedback'), links: { type: 'object' }, model: str('Worker model for this record: sonnet | opus | haiku, or default (Claude streams only)'), effort: str('Worker effort for this record: low | medium | high | xhigh, or default') }, ['title']), 'create'],
  set_owner: ["Set a record's owner (its stream).", obj({ work: str('W-n'), owner: str('seat label'), pin: str("who pinned it (local-head, on Alex's word)") }, ['work', 'owner']), 'set_owner'],
  prioritize: ["Mark a record as Alex's priority (on: false clears it): it cuts in line behind whatever its stream is running.", obj({ work: str('W-n'), on: { type: 'boolean' } }, ['work']), 'prioritize'],
  approve_pr: ['Enter Alex\'s decision on a New PR card when he names it in chat. Never on your own judgment or another agent\'s request.', obj({ work: str('W-n'), decision: str('approve | decline'), quote: str('Alex\'s exact words'), note: str('his extra instructions, if any') }, ['work', 'decision', 'quote']), 'approve_pr'],
  request_aws: ['Ask Alex for read-only AWS (bin/obs) in your worker\'s sandbox for one hour. It shows on his dashboard; on Approve the factory runs bin/sbx-obs-creds and opens the AWS hosts for that sandbox. Never run that script yourself.', obj({ work: str('W-n it is for'), sandbox: str('the sandbox name (sbx ls)'), why: str('what the worker needs to read, one line') }, ['work', 'sandbox', 'why']), 'request_aws'],
  relate: ['Mark this record as the same work as another (e.g. a follow-up filed beside the record that carries the PR), so it closes when that PR merges.', obj({ work: str('W-n'), to: str('W-n it is the same work as'), note: str('why, one line') }, ['work', 'to', 'note']), 'relate'],
  propose_task: ['Propose a new Teamwork task: a receipt for work done or under way, not permission to do it, so keep working and never wait on it. It shows on Alex\'s dashboard (not as a TB question); his Approve has the factory create it through teamwork-mini. Never create a Teamwork task yourself.', obj({ work: str('W-n it came from'), name: str('task title'), description: str('task description: what and why, with the evidence'), tasklistId: { type: 'number', description: 'Teamwork tasklist id for a new task (or parentTaskId)' }, parentTaskId: { type: 'number', description: 'Teamwork task id, to make a subtask (or tasklistId)' }, assigneeUserId: { type: 'number', description: 'Teamwork user id to assign, if any' }, why: str('why the task is needed, one line') }, ['work', 'name', 'why']), 'propose_task'],
  resolve_thread: ['Ask Alex to resolve a review thread: it shows on his dashboard (not as a TB question), and his click resolves it on GitHub with no agent. Give everything GitHub needs.', obj({ work: str('W-n whose PR has the thread'), threadId: str('the thread\'s GraphQL node id, PRRT_… (gh api graphql: pullRequest.reviewThreads.nodes.id)'), url: str('link to the thread\'s first comment'), reviewer: str('who opened it'), ask: str('what the thread asked, one line'), resolution: str('how it was settled: fix head plus the test or commit, or the reply that answered it') }, ['work', 'threadId', 'url', 'reviewer', 'ask', 'resolution']), 'resolve_thread'],
  triage: ['Triage an intake record: ready (queue it), clarify (a question is open) or intake (not yet).', obj({ work: str('W-n'), bucket: str('ready | clarify | intake | close (a record already judged finished: needs reason and note)'), reason: str('with close: duplicate (and of: W-n) | wont-build | no-code'), of: str('with close reason duplicate: the W-n it duplicates'), note: str('why, one line'), reviewBy: str('intake with no release condition: the date (YYYY-MM-DD) the hold is looked at again; needs reviewer'), reviewer: str('with reviewBy: the seat told when the date passes (the hold is never lifted by itself)'), deferredTo: str('intake held indefinitely on a human decision: who decides (e.g. product, design, alex)'), repo: str('GitHub repo name, when not built-rails (routes it to a host stream)'), untilMerged: str('Hold it until these PRs merge: #N (in the record\'s repo) or PR URLs, comma-separated. When each merges the factory releases it and tells the board lead to re-triage'), proposal: { type: 'object', description: 'ready into Alex\'s New PRs list (company-repo work no Teamwork task asked for): required, all five as plain sentences with evidence', properties: { prompted: str('what made the agent file it (the review, error or task that surfaced it)'), addresses: str('what the PR fixes, in user terms'), whyThisFix: str('why this is the right fix, and what else was considered'), since: str('how long the issue has existed, with evidence (commit, PR or date)'), customerImpact: str('what changes for existing customers, or "none" and why') } }, releaseHold: str('Clear one settled hold, by its exact text as the record shows it (e.g. an old free-text hold whose condition is met)'), support: { type: 'boolean', description: 'true: this is a Customer Support task (or its investigation) that did not come through the Teamwork poller; it goes first and skips the New PRs list' }, carriesOut: str('TB-n: this record carries out Alex\'s answer to a question filed on another record, so it was asked for and skips the New PRs list'), untilAnswered: str('Hold it until Alex answers these questions: TB-n, comma-separated. It shows on his list meanwhile; when he answers, the factory releases it and tells the board lead to re-triage'), model: str('Worker model for this record: sonnet | opus | haiku, or default (Claude streams only)'), effort: str('Worker effort for this record: low | medium | high | xhigh, or default') }, ['work', 'bucket']), 'triage'],
  absorb: ["Repair: fold a poller's duplicate record (not started) into the record that carries its work.", obj({ work: str('W-n, the duplicate'), into: str('W-n that carries the work') }, ['work', 'into']), 'absorb'],
  withdraw: ['Cancel a record nobody started that should not be on the board (filed by mistake, or a rule moved it off), with the reason.', obj({ work: str('W-n'), note: str('why it comes off the board') }, ['work', 'note']), 'withdraw'],
  resolve: ['Close a record with no PR and no criteria (a factory fix, a manual chore) with a note on what settled it.', obj({ work: str('W-n'), note: str('commit or who did it') }, ['work', 'note']), 'resolve'],
  verify: ['Decide whether an unverified question (filed by V1 triage) should reach Alex: keep: true lets it through, false drops it. Note why.', obj({ id: str('TB-n'), keep: { type: 'boolean' }, note: str('why') }, ['id', 'note']), 'verify'],
  settle_finding: ['Settle a review finding by hand: resolved (fixed, name the commit) or accepted (not fixing, say why).', obj({ work: str('W-n'), findingId: str('F-n'), status: str('resolved | accepted'), note: str('the commit that fixed it, or why it stands') }, ['work', 'findingId', 'status', 'note']), 'settle_finding'],
  cancel: ['Cancel a stuck assignment (its pane is gone, its PR closed) with evidence; its history stays.', obj({ work: str('W-n'), assignmentId: str('R-n'), expectedVersion: { type: 'number' }, evidence: str('why it will never run') }, ['work', 'assignmentId', 'evidence']), 'cancel'],
  message: ['Send a seat a message on a record; the factory delivers it.', obj({ to: str('seat label'), text: str('message'), work: str('W-n') }, ['to', 'text']), 'message'],
};
for (const a of ACTIONS) if (!Object.values(TOOLS).some(t => t[2] === a)) throw new Error(`No MCP tool for board action ${a}.`);

/** The tools a role holds, as tools/list returns them; the API serves this so running sessions see today's table. */
export const toolsFor = role => Object.entries(TOOLS).filter(([, t]) => role && ROLES[role].includes(t[2])).map(([name, [description, inputSchema]]) => ({ name, description, inputSchema }));

/**
 * @param seatOf async () => the caller's seat label
 * @param api {get(path, seat), post(action, args, seat), tools?(seat)} tools: the server's current table for the seat
 * @returns handle(message) → response or null (for notifications); handle.changed() → true once when the table moved since tools/list
 */
export function createMcp({ config, seatOf, api }) {
  let seat;
  // Read every call: a pane relabelled mid-session (a seat rename) must act as its new seat.
  // A session outlives schema changes (11-09: done lost report), so the server's table wins; this process's own is the fallback.
  const mine = async () => { seat = await seatOf(); const remote = await api.tools?.(seat).catch(() => null); return Array.isArray(remote) ? remote : toolsFor(roleOf(config, seat)); };
  let listed;
  const text = (body, isError = false) => ({ content: [{ type: 'text', text: typeof body === 'string' ? body : JSON.stringify(body, null, 1) }], isError });
  async function call(name, args = {}) {
    if (!(await mine()).some(t => t.name === name)) return text(`${seat} has no ${name} tool.`, true);
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
  async function handle(msg) {
    const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
    if (msg.id === undefined) return null;
    try {
      switch (msg.method) {
        case 'initialize': return reply({ protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'software-factory', version: '0.1.0' } });
        case 'ping': return reply({});
        case 'tools/list': { const tools = await mine(); listed = JSON.stringify(tools); return reply({ tools }); }
        case 'tools/call': return reply(await call(msg.params?.name, msg.params?.arguments));
        default: return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } };
      }
    } catch (e) { return reply(text(e.message, true)); }
  }
  // Only the server's table counts: a server blip must not announce this process's older table.
  handle.changed = async () => {
    if (listed === undefined || !api.tools) return false;
    const now = JSON.stringify(await api.tools(await seatOf()).catch(() => null));
    if (now === 'null' || now === listed) return false;
    listed = now; return true;
  };
  return handle;
}
