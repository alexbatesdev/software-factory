// The factory's decision log: every command is one append-only row, and state is the fold of the rows.
// Observations a reducer reads (now, GitHub reads) are stored on the row, so a replay never consults live data.
import { DatabaseSync } from 'node:sqlite';
import * as W from './work.mjs';
import { parseAcs } from './derive.mjs';
import { inferStream } from './notifier.mjs';
import { sourceIndex, ownerOf, claimPr, refresh } from './correlate.mjs';
import { foldQuestion } from './questions.mjs';
import { PR_REF, prRefUrl } from './units.mjs';
import { foldThread, THREAD_KINDS } from './threads.mjs';
import { foldTaskRequest, TASK_KINDS } from './task-requests.mjs';
import { foldAwsRequest, AWS_KINDS } from './aws-access.mjs';

// Reducer inputs that describe the outside world at decision time. Anything derivable from the log is not stored.
const OBSERVED = ['now', 'by', 'prHead', 'prState', 'verifiedPrs', 'standingWaiver'];

export const emptyState = () => ({ work: {}, questions: {}, threads: {}, taskRequests: {}, awsRequests: {}, notifications: {}, messages: {}, legacy: {}, nextWork: 1, nextMessage: 1, nextQuestion: 1, nextThread: 1, nextTaskRequest: 1, nextAwsRequest: 1, seq: 0 });

// What the reducer needs to know about other records, computed from the fold so far.
/** Support work (Alex's support week, 11-09): a support task's record, or one filed from, under or as the same work as one. */
export function supportOf(state, id, seen = new Set()) {
  const w = state.work[id];
  if (!w || seen.has(id)) return false;
  seen.add(id);
  return !!w.support || [w.proposedFrom, w.parent, ...(w.related || []).filter(r => r.kind === 'same-work').map(r => r.to)].some(r => r && supportOf(state, r, seen));
}

/** prState and owner come only from a live GitHub read; the reducer passes neither, so replay never sees PR state. */
const ANSWERED = ['answered', 'settled'];
/** Work that carries out one of Alex's answers was asked for (W-333): an answered question on the record, or one it names with carriesOut. */
export const askedFor = (state, w) => Object.values(state.questions).some(q => q.work === w.id && ANSWERED.includes(q.status)) || (w.carriesOut || []).some(t => ANSWERED.includes(state.questions[t]?.status));
/** The record as the new-PR gate reads it: support and asked-for work skip Alex's go. */
export const prGateView = (state, w) => ({ ...w, support: supportOf(state, w.id), asked: askedFor(state, w) });

export function derivedCtx(state, id, { prState = () => null, owner } = {}) {
  const rec = d => state.work[d];
  const w = rec(id), keys = new Set([w?.source?.key, ...(w?.aliases || [])].filter(Boolean));
  return {
    openQuestions: Object.values(state.questions).filter(q => q.status === 'open' && (q.work === id || keys.has(q.item))).length,
    openDeps: (rec(id)?.deps || []).filter(d => !W.SATISFIES_DEPS.includes(rec(d)?.phase)),
    depPhase: d => rec(d)?.phase,
    depWorkerDone: d => [...(rec(d)?.assignments || [])].reverse().find(a => a.kind !== 'review')?.status === 'done',
    parked: (w?.assignments || []).filter(W.parked).map(a => {
      const merged = PR_REF.test(a.waitingOn) && prState(prRefUrl(w, a.waitingOn, owner)) === 'MERGED';
      return { assignmentId: a.id, version: a.version, waitingOn: a.waitingOn, ...(merged && { why: `${a.waitingOn} merged on GitHub` }),
        cleared: /^TB-\d+$/.test(a.waitingOn) ? state.questions[a.waitingOn]?.status !== 'open' : /^W-\d+$/.test(a.waitingOn) ? W.SATISFIES_DEPS.includes(rec(a.waitingOn)?.phase) : merged };
    }),
  };
}

// A record opened for a Teamwork task an earlier support record carried (a reopened investigation) is support too (W-405).
const DUP_PR_FROM = '2026-11-11T21:20:00.000Z';
const SUPPORT_REOPEN_FROM = '2026-11-11T16:30:00.000Z';
const taskOf = w => w.source?.key?.startsWith('tw-') ? w.source.key : `tw-${String(w.links?.source || '').match(/teamwork\.com\/app\/tasks\/(\d+)/)?.[1]}`;
function create(state, fields, ctx) {
  const id = `W-${state.nextWork++}`;
  const task = ctx.now >= SUPPORT_REOPEN_FROM && fields.links?.source && taskOf(fields);
  const support = task && Object.values(state.work).some(w => w.support && taskOf(w) === task);
  state.work[id] = W.createWork({ ...fields, id }, ctx);
  if (support) state.work[id].support = true;
  const claim = fields.links?.pr && claimPr(state, id, fields.links.pr);
  if (claim) state.work[claim.absorb] = W.applyEvent(state.work[claim.absorb], { type: 'absorb', into: id }, ctx).work;
  return id;
}

// An imported record is V1's word for it, stored as is: nothing here re-normalizes it.
function importRow(state, target, payload) {
  const [c, key] = target.split('/');
  if (c === 'legacy' && key === 'nextWork') state.nextWork = payload ?? state.nextWork;
  if (c === 'legacy' && key === 'nextQuestion') state.nextQuestion = payload ?? state.nextQuestion;
  if (payload === null) delete state[c][key]; else state[c][key] = payload;
}

// A message is addressed to a seat label and stays open until that seat acks it; a wake only says it exists.
function foldMessage(state, { kind, target, payload, ctx }) {
  if (kind === 'message') {
    if (!payload.to || !payload.text) throw new Error('A message needs to and text.');
    const id = `M-${state.nextMessage++}`;
    // An fyi needs no action, so it is stored acked: never unread, never a wake (11-09).
    const fyi = !!payload.about?.fyi;
    state.messages[id] = { id, to: payload.to, from: ctx.by, work: payload.work || null, about: payload.about || {}, text: payload.text, at: ctx.now, ackedAt: fyi ? ctx.now : null, ackedBy: fyi ? 'fyi' : null };
    return id;
  }
  const m = state.messages[target] || (() => { throw new Error(`There is no message ${target}.`); })();
  if (ctx.by !== m.to) throw new Error(`${target} is addressed to ${m.to}; only that seat acks it.`);
  if (!m.ackedAt) state.messages[target] = { ...m, ackedAt: ctx.now, ackedBy: ctx.by, outcome: payload.outcome || 'received' };
  return target;
}

/** Apply one logged row to state in place. Throws when the reducer refuses it. */
export function fold(state, row, { supervisors = [] } = {}) {
  const { kind, target: id, payload, ctx: observed } = row;
  if (kind === 'import') { importRow(state, id, payload); state.seq = row.seq; return id; }
  if (THREAD_KINDS.includes(kind)) { const t = foldThread(state, row); state.seq = row.seq; return t; }
  if (TASK_KINDS.includes(kind)) { const t = foldTaskRequest(state, row); state.seq = row.seq; return t; }
  if (AWS_KINDS.includes(kind)) { const t = foldAwsRequest(state, row); state.seq = row.seq; return t; }
  if (kind === 'message' || kind === 'ack_message') { const m = foldMessage(state, row); state.seq = row.seq; return m; }
  if (['ask', 'answer', 'route', 'question_ack', 'question_verify', 'question_close', 'question_amend'].includes(kind)) {
    const q = foldQuestion(state, row);
    // The last answer frees a record waiting in clarification, by the same rule as triage (V1 did this after every answer).
    const w = state.work[state.questions[q]?.work];
    if (['answer', 'question_verify'].includes(kind) && w?.phase === 'clarification' && !w.waitingOn) {
      const next = W.syncIntake(w, { bucket: w.triage?.bucket || 'clarify', openQuestions: derivedCtx(state, w.id).openQuestions });
      if (next.phase !== w.phase) state.work[w.id] = { ...next, updates: [...w.updates, { at: observed.now, by: observed.by, text: `Questions answered; ${next.phase === 'ready' ? 'ready to queue' : `back to ${next.phase}`}.` }] };
    }
    // An answered or closed question releases a record wait that names it (W-375), from ANSWER_RELEASES_FROM for replay.
    if (observed.now >= ANSWER_RELEASES_FROM && state.questions[q]?.status !== 'open')
      for (const r of Object.values(state.work)) if (r.waitingOn?.who === q)
        state.work[r.id] = { ...r, waitingOn: null, updates: [...r.updates, { at: observed.now, by: observed.by, text: `No longer waiting on ${q}: it is ${state.questions[q].status}.` }] };
    finish(state, row, observed, null, supervisors);
    return q;
  }
  if (kind === 'rename_seat') {
    // A seat's label is an exact string everywhere it's stored (stream, owners, askers, keys); free text keeps the old name.
    const swap = v => v === payload.from ? payload.to : Array.isArray(v) ? v.map(swap)
      : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k === payload.from ? payload.to : k, swap(x)])) : v;
    Object.assign(state, swap(state)); state.seq = row.seq; return null;
  }
  if (kind === 'observe_source') { const t = observeSource(state, payload, observed); finish(state, row, observed, t, supervisors); return t; }
  const ctx = id ? { ...observed, ...derivedCtx(state, id) } : observed;
  const cur = id && (state.work[id] || (() => { throw new Error(`There is no work item ${id}.`); })());
  let touched = id;
  switch (kind) {
    case 'create': touched = create(state, payload, ctx); break;
    case 'update': {
      const claim = payload.links?.pr && claimPr(state, id, payload.links.pr);
      if (claim) state.work[claim.absorb] = W.applyEvent(state.work[claim.absorb], { type: 'absorb', into: id }, ctx).work;
      state.work[id] = W.updateWork(cur, claim ? { ...payload, aliases: [...new Set([...(cur.aliases || []), claim.key])] } : payload, ctx);
      break;
    }
    case 'source_gone': {
      const w = structuredClone(cur);
      w.upstream = 'gone';
      w.updates.push({ at: ctx.now, by: ctx.by, text: w.source.type === 'pr' ? 'No unresolved feedback on the PR any more (or it closed). Record kept.' : 'No longer in your open Teamwork tasks. Record kept.' });
      state.work[id] = w;
      break;
    }
    case 'event': {
      const { work, spawn } = W.applyEvent(cur, payload, ctx);
      state.work[id] = work;
      if (spawn) work.updates.at(-1).text += ` (${create(state, spawn, ctx)})`;
      // The absorbing record takes the absorbed one's source key, so pollers find it there.
      const into = payload.type === 'absorb' ? payload.into : payload.type === 'withdraw' ? payload.duplicateOf : null;
      if (into && cur.source?.key && state.work[into]) state.work[into] = { ...state.work[into], aliases: [...new Set([...(state.work[into].aliases || []), cur.source.key])] };
      // ...and its PR link when it has none, or the ready gate never sees that PR (W-418: W-359 waited 24h on #8699).
      if (into && ctx.now >= DUP_PR_FROM && cur.links?.pr && state.work[into] && !state.work[into].links?.pr) state.work[into] = { ...state.work[into], links: { ...state.work[into].links, pr: cur.links.pr } };
      // The request ack is the seat's answer to the message about it; a still-open message would wake the seat for nothing.
      if (payload.type === 'ack') for (const m of Object.values(state.messages))
        if (!m.ackedAt && m.about?.requests === `${id}/${payload.requestId}`) state.messages[m.id] = { ...m, ackedAt: ctx.now, ackedBy: payload.by, outcome: 'request acked' };
      break;
    }
    case 'observe_head': state.work[id] = W.observeHead(cur, payload, ctx); break;
    case 'observe_health': state.work[id] = W.observeHealth(cur, payload, ctx); break;
    case 'observe_project': state.work[id] = { ...cur, project: { id: String(payload.id), name: String(payload.name) } }; break;
    case 'unverify_head': state.work[id] = W.unverifyHead(cur, ctx); break;
    case 'sync_intake': {
      // Open questions come from the fold, never from the caller.
      state.work[id] = { ...W.syncIntake(cur, { bucket: payload.bucket, openQuestions: ctx.openQuestions }), triage: { bucket: payload.bucket, by: ctx.by, at: ctx.now, note: payload.note || null } };
      if (payload.note) state.work[id] = { ...state.work[id], updates: [...cur.updates, { at: ctx.now, by: ctx.by, text: `Triaged ${payload.bucket} by ${ctx.by}: ${payload.note}` }] };
      break;
    }
    default: throw new Error(`Unknown command kind "${kind}".`);
  }
  finish(state, row, observed, touched, supervisors);
  return touched;
}

function finish(state, row, observed, touched, supervisors) {
  // A record takes its stream once, from a supervisor that owns or owned it, so owner and stream never drift apart.
  const t = state.work[touched];
  if (t && !t.stream) { const s = inferStream(t, observed.supervisors || []); if (s) state.work[touched] = { ...t, stream: s }; }
  // Ready labels drop as soon as a dependency regresses, not only on the item's own events. Never pass on this row's observations.
  for (const [wid, w] of Object.entries(state.work)) {
    if (['ready_for_human', 'awaiting_human_approval'].includes(w.phase)) state.work[wid] = W.normalize(w, { now: observed.now, by: 'board', ...derivedCtx(state, wid) });
  }
  state.seq = row.seq;
}

// A task or PR seen by a poller: refresh its record, attach it to the record that carries it, or open a new one.
// From here a live record that links a Teamwork task URL is that task's record (W-353: W-352 and W-354 were one task). Gated for replay.
const ANSWER_RELEASES_FROM = '2026-11-10T22:45:00.000Z';
const TW_LINK_FROM = '2026-11-10T19:15:00.000Z';
const twLinked = (state, item) => item.kind === 'task' && Object.values(state.work).find(w => !W.TERMINAL.includes(w.phase) && !w.source?.key?.startsWith('tw-')
  && `tw-${String(w.links?.source || '').match(/teamwork\.com\/app\/tasks\/(\d+)/)?.[1]}` === item.id);

function observeSource(state, item, ctx) {
  const idx = sourceIndex(state), linked = ctx.now >= TW_LINK_FROM && !idx.has(item.id) && twLinked(state, item);
  const o = linked ? { id: linked.id, why: 'this record links the task' } : ownerOf(state, item, idx, ctx.now);
  if (!o) {
    const id = create(state, { title: item.title, kind: item.kind === 'task' ? 'build' : 'pr-feedback', source: { type: item.kind === 'task' ? 'teamwork' : 'pr', key: item.id } }, ctx);
    state.work[id] = refresh(state.work[id], item, parseAcs, ctx.now);
    return id;
  }
  const w = state.work[o.id];
  if (w.source?.key === item.id) { state.work[o.id] = refresh(w, item, parseAcs, ctx.now); return o.id; }
  if ((w.aliases || []).includes(item.id)) {
    if (item.kind === 'pr' && !w.links?.pr && !W.TERMINAL.includes(w.phase) && ctx.now >= DUP_PR_FROM) {
      state.work[o.id] = W.updateWork(w, { links: { pr: item.url, ...(w.links?.branch ? {} : { branch: item.branch }) } }, ctx);
      state.work[o.id].updates.at(-1).text += ` ${item.ref} linked: this record holds its key (W-418).`;
    }
    return o.id;
  }
  // Joining a record (e.g. a task's own PR, by branch): the key becomes an alias; the record keeps its title and an existing PR link.
  state.work[o.id] = W.updateWork(w, { aliases: [...(w.aliases || []), item.id], ...(item.kind === 'pr' && !w.links?.pr ? { links: { pr: item.url, branch: item.branch } } : {}), ...(linked && item.support ? { support: true } : {}) }, ctx);
  state.work[o.id].updates.at(-1).text += ` ${item.ref} joined: ${o.why}.`;
  return o.id;
}

export function openStore(path = ':memory:', opts = {}) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, at TEXT NOT NULL, by TEXT NOT NULL,
    kind TEXT NOT NULL, target TEXT, payload TEXT NOT NULL, ctx TEXT NOT NULL)`);
  const rows = () => db.prepare('SELECT * FROM events ORDER BY seq').all()
    .map(r => ({ ...r, payload: JSON.parse(r.payload), ctx: JSON.parse(r.ctx) }));
  const replay = () => { const s = emptyState(); for (const r of rows()) fold(s, r, opts); return s; };
  let state = replay();

  return {
    get state() { return state; },
    rows,
    replay,
    /**
     * Decide and record commands, all or none: a refused command writes nothing. A repeated eventId is applied once.
     * Payloads round-trip through JSON so the live state is exactly what a replay rebuilds.
     * @param cmds [{kind, target?, payload, eventId?, ctx?}] (a command's own ctx adds observations) @param ctx {now, by, ...observations}
     * @returns [{id, seq, duplicate?}]
     */
    appendAll(cmds, ctx) {
      if (!ctx?.now || !ctx?.by) throw new Error('A command needs ctx.now and ctx.by.');
      // The supervisor list is recorded per row, so a replay never re-derives streams from today's config.
      const observe = c => ({ ...Object.fromEntries(OBSERVED.filter(k => c[k] !== undefined).map(k => [k, c[k]])), ...(opts.supervisors?.length ? { supervisors: opts.supervisors } : {}) });
      // ponytail: clones the whole state per call (3.9 ms measured on the 1.1 MB V1 state); fold into a scratch copy of the touched records if appends get hot.
      const next = structuredClone(state), out = [], rowsToWrite = [];
      for (const cmd of cmds) {
        if (cmd.eventId && db.prepare('SELECT seq FROM events WHERE event_id = ?').get(cmd.eventId)) { out.push({ id: cmd.target, duplicate: true }); continue; }
        const row = { seq: next.seq + 1, kind: cmd.kind, target: cmd.target || null, payload: JSON.parse(JSON.stringify(cmd.payload === undefined ? {} : cmd.payload)), ctx: observe({ ...ctx, ...cmd.ctx, now: ctx.now, by: ctx.by }) };
        out.push({ id: fold(next, row, opts), seq: row.seq });
        rowsToWrite.push([cmd.eventId || null, row]);
      }
      db.exec('BEGIN');
      try {
        for (const [eventId, row] of rowsToWrite) db.prepare('INSERT INTO events (seq, event_id, at, by, kind, target, payload, ctx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(row.seq, eventId, ctx.now, ctx.by, row.kind, row.target, JSON.stringify(row.payload), JSON.stringify(row.ctx));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      state = next;
      return out;
    },
    append(cmd, ctx) { return this.appendAll([cmd], ctx)[0]; },
    close: () => db.close(),
  };
}
