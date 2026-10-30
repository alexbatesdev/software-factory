// The factory's decision log: every command is one append-only row, and state is the fold of the rows.
// Observations a reducer reads (now, GitHub reads) are stored on the row, so a replay never consults live data.
import { DatabaseSync } from 'node:sqlite';
import * as W from './work.mjs';

// Reducer inputs that describe the outside world at decision time. Anything derivable from the log is not stored.
const OBSERVED = ['now', 'by', 'prHead', 'prState', 'verifiedPrs', 'standingWaiver', 'openQuestions'];

export const emptyState = () => ({ work: {}, nextWork: 1, seq: 0 });

// What the reducer needs to know about other records, computed from the fold so far.
function derivedCtx(state, id) {
  const rec = d => state.work[d];
  return {
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

/** Apply one logged row to state in place. Throws when the reducer refuses it. */
export function fold(state, row) {
  const { kind, target: id, payload, ctx: observed } = row;
  const ctx = id ? { ...observed, ...derivedCtx(state, id), openQuestions: observed.openQuestions ?? 0 } : observed;
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
  // Ready labels drop as soon as a dependency regresses, not only on the item's own events.
  for (const [wid, w] of Object.entries(state.work)) {
    if (['ready_for_human', 'awaiting_human_approval'].includes(w.phase)) state.work[wid] = W.normalize(w, { ...ctx, ...derivedCtx(state, wid) });
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
      const next = structuredClone(state);
      const row = { seq: state.seq + 1, kind: cmd.kind, target: cmd.target || null, payload: cmd.payload ?? {}, ctx: observed };
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
