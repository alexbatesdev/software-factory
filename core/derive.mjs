import { TERMINAL, LIVE_ASSIGNMENT } from './work.mjs';
// What a card shows that the board works out for Alex: verbatim ACs, derived dependencies, and the one-line
// "waiting on" summary. Pure; display only. None of it feeds the gate (criteria, deps) or auto-dispatch.

const AC_HEAD = /^\W*acceptance criteria\W*$/i;
// A heading ends the section: a bold line, the FOR DEV block, or a short label line in stripped HTML.
const HEADING = /^(\*\*\*?[^*]+\*\*\*?:?.*|(requirements|tests|permissions|copy|edge cases|background|notes?|figma|spec)\s*:?)$/i;

/** The task's acceptance criteria, word for word (bullet markers only removed). */
export function parseAcs(description) {
  const lines = String(description || '').split('\n').map(l => l.trim());
  const start = lines.findIndex(l => AC_HEAD.test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (!l) { if (out.length) break; continue; }
    if (HEADING.test(l)) break;
    out.push(l.replace(/^[*\-•]\s+/, ''));
  }
  return out;
}

const MENTION = /\b(depends on|blocked by|stacked on|after)\s+(#\d+|TW\s*\d+|tasks\/\d+)/gi;

/**
 * @param key the record's source key (tw-n or repo-n)
 * @param tasks observed Teamwork items by key; prs observed PR items by key; bySource state.workBySource
 * @param texts [{text, source}] task description and human comments to scan for dependency wording
 */
export function derivedDeps({ key, tasks, prs, bySource, texts = [] }) {
  const out = [];
  const task = tasks.get(key), pr = prs.get(key);
  if (task) {
    if (task.parentTaskId) out.push({ kind: 'parent', ref: `TW ${task.parentTaskId}`, work: bySource[`tw-${task.parentTaskId}`] || null, source: `from TW ${task.ref} (parent task)` });
    for (const c of tasks.values()) if (String(c.parentTaskId) === String(task.ref)) out.push({ kind: 'child', ref: `TW ${c.ref}`, work: bySource[c.id] || null, source: `from TW ${task.ref} (subtask)` });
  }
  if (pr?.base) {
    const under = [...prs.values()].find(p => p.branch === pr.base && p.repo === pr.repo);
    if (under) out.push({ kind: 'stacked-on', ref: `${under.repo}#${under.number}`, work: bySource[under.id] || null, source: `from PR base branch ${pr.base}` });
  }
  for (const { text, source } of texts) for (const m of String(text || '').matchAll(MENTION)) {
    const ref = m[2].replace(/^tasks\//, 'TW ').replace(/^TW\s*/, 'TW ');
    if (!out.some(d => d.ref === ref)) out.push({ kind: 'mentioned', ref, work: null, source: `from ${source}: "${m[0]}"` });
  }
  return out;
}

const prNum = w => (String(w.links?.pr || '').match(/\/pull\/(\d+)/) || [])[1];
const live = (w, kind) => (w.assignments || []).find(a => LIVE_ASSIGNMENT.includes(a.status) && (!kind || (kind === 'review') === (a.kind === 'review')));

/**
 * One plain line: what the card waits on and who acts. `questions` are this record's question objects.
 * @returns {{who: string|null, text: string, question?: object}|null} null when nothing waits (done, cancelled)
 */
export function waitingOn(w, { questions = [] } = {}) {
  // Factory records are the board developer's queue, never a stream's.
  if (w.kind === 'factory' && !TERMINAL.includes(w.phase)) return { who: 'triage board worker', text: 'Waiting on the board developer (triage board worker) to fix it' };
  if (TERMINAL.includes(w.phase)) return null;
  const open = questions.filter(q => q.status === 'open');
  const mine = open.find(reachesAlex);
  if (mine) return { who: 'you', text: `Waiting on you: ${mine.id} — ${mine.title}`, question: mine, more: open.length - 1 };
  if (open.length) return { who: 'triage', text: `Waiting on verification of ${open[0].id} — ${open[0].title}`, question: open[0], more: open.length - 1 };
  const lost = lostAnswer(w, questions);
  if (lost) return { who: 'you', text: `Waiting on you: pick a stream for ${w.id} so your answer to ${lost.id} reaches someone, or say it isn't stream work`, question: lost };
  // A permission prompt in the stream's pane: only a person can answer it (server baseView sets paneBlocked).
  if (w.paneBlocked) return { who: 'you', text: `Waiting on you: ${w.paneBlocked} is waiting at a prompt; answer it in that pane` };
  const unackedAnswer = questions.find(q => q.status === 'answered' && q.answer?.ackAsked && !q.answer.ack);
  if (unackedAnswer) return { who: unackedAnswer.answer.sentTo, text: `Waiting on ${unackedAnswer.answer.sentTo}: your answer to ${unackedAnswer.id} was delivered but not acknowledged` };
  if (w.intakeHold) return { who: w.intakeHold.by, text: `Held out of triage by ${w.intakeHold.by}: ${w.intakeHold.reason}` };
  if (w.waitingOn) return { who: w.waitingOn.who, text: `Waiting on ${w.waitingOn.who}: ${w.waitingOn.what}` };
  if (w.externalDeps?.length) return { who: null, text: `Waiting on ${w.externalDeps.map(d => d.text || d.ref).join('; ')}` };
  if (w.openDeps?.length) return { who: null, text: `Waiting on ${w.openDeps.join(', ')} to finish` };
  if (workerStopCurrent(w) && w.workerStop.notifiedAt) {
    const t = new Date(w.workerStop.notifiedAt), hh = String(t.getHours()).padStart(2, '0'), mm = String(t.getMinutes()).padStart(2, '0');
    return { who: w.workerStop.to, text: `Worker finished; ${w.workerStop.to} notified ${hh}:${mm} to record the result` };
  }
  const n = prNum(w), pr = n ? `#${n}` : 'the PR', to = w.route;
  const owner = to || 'an owner';
  const unacked = type => (w.requests || []).some(r => r.type === type && !r.ack);
  switch (w.phase) {
    case 'awaiting_human_approval': {
      const fix = (w.assignments || []).find(a => a.kind === 'fixes' && a.status === 'queued');
      return fix ? { who: w.stream || null, text: `Waiting on the stream: ${fix.id} fixes queued on ${pr}${w.queueHold ? ` ${w.queueHold}` : ''}, then 1 QA + 1 dev approval` } : { who: 'reviewers', text: `Waiting for 1 QA + 1 dev approval on ${pr}` };
    }
    case 'awaiting_alex_review': return { who: 'you', text: `Waiting on you: read the trusted review and submit your own review of ${pr}` };
    case 'ready_for_human': {
      // The board marks it ready under Alex's standing authorization; only a failed or uncertain attempt needs a person.
      const op = (w.prReadyOps || []).filter(o => o.head === w.head).at(-1);
      return ['failed', 'uncertain'].includes(op?.status) ? { who: 'you', text: `Waiting on you: marking ${pr} ready was ${op.status} (${op.id}); check GitHub` } : { who: 'board', text: `Waiting on the board: marking ${pr} ready` };
    }
    case 'review': case 'rereview': {
      const a = live(w, 'review');
      if (a) return { who: a.owner, text: `Waiting on ${a.owner}: internal review at ${String(w.head || '').slice(0, 11)}` };
      return { who: to, text: `Waiting on ${owner}: ${unacked('review') ? 'pick up the review request' : 'run the internal review'} at ${String(w.head || '').slice(0, 11) || 'the current head'}` };
    }
    case 'fixes': return { who: to, text: `Waiting on ${owner}: fix the review findings on ${pr}` };
    case 'implementation': { const a = live(w, 'work'); return { who: a?.owner || to, text: `Waiting on ${a?.owner || owner}: building${a ? ` (${a.id})` : ''}` }; }
    case 'queued':
      if (!to) return { who: null, text: 'Waiting for an owner: no stream supervisor is set' };
      return { who: to, text: `Waiting on ${to}: ${unacked('dispatch') ? 'pick up the dispatch' : 'start the brief'}${w.queueHold ? ` (${w.queueHold.replace(/^behind /, 'queued behind ')})` : ''}` };
    case 'ready':
      if (!to) return { who: null, text: 'Waiting for an owner: no stream supervisor is set' };
      return { who: to, text: `Waiting for ${to} to be free (auto-dispatch starts it)` };
    default: return { who: 'triage', text: 'Waiting on triage' };
  }
}

/** A worker-stop notice still describes the record: the same assignment, unchanged since, and still started. */
export function workerStopCurrent(w) {
  const ws = w.workerStop, a = ws && (w.assignments || []).find(x => x.id === ws.assignment);
  return !!a && a.status === 'started' && a.version === ws.version;
}

/** An answer of Alex's that reached nobody and still could: no stream, not parked on a wait, not closed. */
export function lostAnswer(w, questions) {
  if (w.stream || w.route || w.waitingOn || TERMINAL.includes(w.phase)) return null;
  return questions.find(q => q.status === 'answered' && q.answer && !q.answer.sentTo && q.answer.unsent) || null;
}

/** The parent task, for anything that asks questions about a task: read it first so the question isn't one it answers. */
export function parentContext(it, parents) {
  const p = it?.parentTaskId && parents.get(`tw-${it.parentTaskId}`);
  if (!p) return '';
  return `Parent task TW ${p.ref}: "${p.title}"\n${String(p.description || '').slice(0, 1500)}\nRead the parent first: don't ask what it already answers (which product, integration or project this belongs to).\n`;
}

/** A question in front of Alex: open and verified, or one an agent couldn't verify (shown with its reason). */
export const reachesAlex = q => q.status === 'open' && ['verified', 'unverifiable'].includes(q.verification);
