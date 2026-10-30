// The factory's decision log: every command is one append-only row, and state is the fold of the rows.
// Observations a reducer reads (now, GitHub reads) are stored on the row, so a replay never consults live data.
import { DatabaseSync } from 'node:sqlite';
import * as W from './work.mjs';

// Reducer inputs that describe the outside world at decision time. Anything derivable from the log is not stored.
const OBSERVED = ['now', 'by', 'prHead', 'prState', 'verifiedPrs', 'standingWaiver'];

export const emptyState = () => ({ work: {}, questions: {}, notifications: {}, messages: {}, legacy: {}, nextWork: 1, nextMessage: 1, seq: 0 });

// What the reducer needs to know about other records, computed from the fold so far.
function derivedCtx(state, id) {
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
  return id;
}

// An imported record is V1's word for it, stored as is: nothing here re-normalizes it.
function importRow(state, target, payload) {
  if (target === 'legacy') { state.legacy = payload; state.nextWork = payload.nextWork ?? state.nextWork; return; }
  const [c, key] = target.split('/');
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
export function fold(state, row) {
  const { kind, target: id, payload, ctx: observed } = row;
  if (kind === 'import') { importRow(state, id, payload); state.seq = row.seq; return id; }
  if (kind === 'message' || kind === 'ack_message') { const m = foldMessage(state, row); state.seq = row.seq; return m; }
  const ctx = id ? { ...observed, ...derivedCtx(state, id) } : observed;
  const cur = id && (state.work[id] || (() => { throw new Error(`There is no work item ${id}.`); })());
  let touched = id;
  switch (kind) {
    case 'create': touched = create(state, payload, ctx); break;
    case 'update': state.work[id] = W.updateWork(cur, payload, ctx); break;
    case 'event': {
      const { work, spawn } = W.applyEvent(cur, payload, ctx);
      state.work[id] = work;
      if (spawn) work.updates.at(-1).text += ` (${create(state, spawn, ctx)})`;
      break;
    }
    case 'observe_head': state.work[id] = W.observeHead(cur, payload, ctx); break;
    case 'unverify_head': state.work[id] = W.unverifyHead(cur, ctx); break;
    case 'sync_intake': state.work[id] = W.syncIntake(cur, payload); break;
    default: throw new Error(`Unknown command kind "${kind}".`);
  }
  // Ready labels drop as soon as a dependency regresses, not only on the item's own events. Never pass on this row's observations.
  for (const [wid, w] of Object.entries(state.work)) {
    if (['ready_for_human', 'awaiting_human_approval'].includes(w.phase)) state.work[wid] = W.normalize(w, { now: observed.now, by: 'board', ...derivedCtx(state, wid) });
  }
  state.seq = row.seq;
  return touched;
}

export function openStore(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, at TEXT NOT NULL, by TEXT NOT NULL,
    kind TEXT NOT NULL, target TEXT, payload TEXT NOT NULL, ctx TEXT NOT NULL)`);
  const rows = () => db.prepare('SELECT * FROM events ORDER BY seq').all()
    .map(r => ({ ...r, payload: JSON.parse(r.payload), ctx: JSON.parse(r.ctx) }));
  const replay = () => { const s = emptyState(); for (const r of rows()) fold(s, r); return s; };
  let state = replay();

  return {
    get state() { return state; },
    rows,
    replay,
    /**
     * Decide and record one command. A refused command writes nothing; a repeated eventId is applied once.
     * @param cmd {kind, target?, payload, eventId?} @param ctx {now, by, ...observations}
     * @returns {{id, seq, duplicate?}}
     */
    append(cmd, ctx) {
      if (!ctx?.now || !ctx?.by) throw new Error('A command needs ctx.now and ctx.by.');
      if (cmd.eventId && db.prepare('SELECT seq FROM events WHERE event_id = ?').get(cmd.eventId)) return { id: cmd.target, duplicate: true };
      const observed = Object.fromEntries(OBSERVED.filter(k => ctx[k] !== undefined).map(k => [k, ctx[k]]));
      // ponytail: clones the whole state per command (3.9 ms measured on the 1.1 MB V1 state); fold into a scratch copy of the touched records if appends get hot.
      const next = structuredClone(state);
      const row = { seq: state.seq + 1, kind: cmd.kind, target: cmd.target || null, payload: structuredClone(cmd.payload === undefined ? {} : cmd.payload), ctx: observed };
      const id = fold(next, row);
      const { lastInsertRowid } = db.prepare('INSERT INTO events (event_id, at, by, kind, target, payload, ctx) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(cmd.eventId || null, ctx.now, ctx.by, row.kind, row.target, JSON.stringify(row.payload), JSON.stringify(observed));
      next.seq = Number(lastInsertRowid);
      state = next;
      return { id, seq: next.seq };
    },
    close: () => db.close(),
  };
}
