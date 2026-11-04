// The factory's decision log: every command is one append-only row, and state is the fold of the rows.
// Observations a reducer reads (now, GitHub reads) are stored on the row, so a replay never consults live data.
import { DatabaseSync } from 'node:sqlite';
import * as W from './work.mjs';
import { parseAcs } from './derive.mjs';
import { inferStream } from './notifier.mjs';
import { sourceIndex, ownerOf, claimPr, refresh } from './correlate.mjs';
import { foldQuestion } from './questions.mjs';

// Reducer inputs that describe the outside world at decision time. Anything derivable from the log is not stored.
const OBSERVED = ['now', 'by', 'prHead', 'prState', 'verifiedPrs', 'standingWaiver'];

export const emptyState = () => ({ work: {}, questions: {}, notifications: {}, messages: {}, legacy: {}, nextWork: 1, nextMessage: 1, nextQuestion: 1, seq: 0 });

// What the reducer needs to know about other records, computed from the fold so far.
export function derivedCtx(state, id) {
  const rec = d => state.work[d];
  const w = rec(id), keys = new Set([w?.source?.key, ...(w?.aliases || [])].filter(Boolean));
  return {
    openQuestions: Object.values(state.questions).filter(q => q.status === 'open' && (q.work === id || keys.has(q.item))).length,
    openDeps: (rec(id)?.deps || []).filter(d => !W.SATISFIES_DEPS.includes(rec(d)?.phase)),
    depPhase: d => rec(d)?.phase,
    depWorkerDone: d => [...(rec(d)?.assignments || [])].reverse().find(a => a.kind !== 'review')?.status === 'done',
  };
}

function create(state, fields, ctx) {
  const id = `W-${state.nextWork++}`;
  state.work[id] = W.createWork({ ...fields, id }, ctx);
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
    state.messages[id] = { id, to: payload.to, from: ctx.by, work: payload.work || null, about: payload.about || {}, text: payload.text, at: ctx.now, ackedAt: null, ackedBy: null };
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
  if (kind === 'message' || kind === 'ack_message') { const m = foldMessage(state, row); state.seq = row.seq; return m; }
  if (['ask', 'answer', 'route', 'question_ack', 'question_verify'].includes(kind)) {
    const q = foldQuestion(state, row);
    // The last answer frees a record waiting in clarification, by the same rule as triage (V1 did this after every answer).
    const w = state.work[state.questions[q]?.work];
    if (['answer', 'question_verify'].includes(kind) && w?.phase === 'clarification' && !w.waitingOn) {
      const next = W.syncIntake(w, { bucket: w.triage?.bucket || 'clarify', openQuestions: derivedCtx(state, w.id).openQuestions });
      if (next.phase !== w.phase) state.work[w.id] = { ...next, updates: [...w.updates, { at: observed.now, by: observed.by, text: `Questions answered; ${next.phase === 'ready' ? 'ready to queue' : `back to ${next.phase}`}.` }] };
    }
    finish(state, row, observed, null, supervisors);
    return q;
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
      if (payload.type === 'absorb' && cur.source?.key && state.work[payload.into]) state.work[payload.into] = { ...state.work[payload.into], aliases: [...new Set([...(state.work[payload.into].aliases || []), cur.source.key])] };
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
function observeSource(state, item, ctx) {
  const o = ownerOf(state, item, sourceIndex(state));
  if (!o) {
    const id = create(state, { title: item.title, kind: item.kind === 'task' ? 'build' : 'pr-feedback', source: { type: item.kind === 'task' ? 'teamwork' : 'pr', key: item.id } }, ctx);
    state.work[id] = refresh(state.work[id], item, parseAcs);
    return id;
  }
  const w = state.work[o.id];
  if (w.source?.key === item.id) { state.work[o.id] = refresh(w, item, parseAcs); return o.id; }
  if ((w.aliases || []).includes(item.id)) return o.id;
  // Joining a record (e.g. a task's own PR, by branch): the key becomes an alias; the record keeps its title and an existing PR link.
  state.work[o.id] = W.updateWork(w, { aliases: [...(w.aliases || []), item.id], ...(item.kind === 'pr' && !w.links?.pr ? { links: { pr: item.url, branch: item.branch } } : {}) }, ctx);
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
     * @param cmds [{kind, target?, payload, eventId?}] @param ctx {now, by, ...observations}
     * @returns [{id, seq, duplicate?}]
     */
    appendAll(cmds, ctx) {
      if (!ctx?.now || !ctx?.by) throw new Error('A command needs ctx.now and ctx.by.');
      // The supervisor list is recorded per row, so a replay never re-derives streams from today's config.
      const observed = { ...Object.fromEntries(OBSERVED.filter(k => ctx[k] !== undefined).map(k => [k, ctx[k]])), ...(opts.supervisors?.length ? { supervisors: opts.supervisors } : {}) };
      // ponytail: clones the whole state per call (3.9 ms measured on the 1.1 MB V1 state); fold into a scratch copy of the touched records if appends get hot.
      const next = structuredClone(state), out = [], rowsToWrite = [];
      for (const cmd of cmds) {
        if (cmd.eventId && db.prepare('SELECT seq FROM events WHERE event_id = ?').get(cmd.eventId)) { out.push({ id: cmd.target, duplicate: true }); continue; }
        const row = { seq: next.seq + 1, kind: cmd.kind, target: cmd.target || null, payload: JSON.parse(JSON.stringify(cmd.payload === undefined ? {} : cmd.payload)), ctx: observed };
        out.push({ id: fold(next, row, opts), seq: row.seq });
        rowsToWrite.push([cmd.eventId || null, row]);
      }
      db.exec('BEGIN');
      try {
        for (const [eventId, row] of rowsToWrite) db.prepare('INSERT INTO events (seq, event_id, at, by, kind, target, payload, ctx) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(row.seq, eventId, ctx.now, ctx.by, row.kind, row.target, JSON.stringify(row.payload), JSON.stringify(observed));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      state = next;
      return out;
    },
    append(cmd, ctx) { return this.appendAll([cmd], ctx)[0]; },
    close: () => db.close(),
  };
}
