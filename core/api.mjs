// The factory's HTTP API: every write is a board action, checked against the caller's role, appended atomically.
// The caller's seat comes from the x-seat header, which the MCP server fills from its pane. ponytail: trusted because
// only local processes reach 127.0.0.1; a cloud deployment needs factory-issued seat tokens instead.
import { refusal, isTrustedReviewSeat } from './capabilities.mjs';
import { commandsFor } from './actions.mjs';
import { readFileSync } from 'node:fs';
import { boardView } from '../views/board.mjs';
import { reachesAlex } from './derive.mjs';
import { escapes } from './work.mjs';
import { resolveThreads } from '../effects/threads.mjs';

const PAGE = new URL('../views/index.html', import.meta.url);

/** The role a seat label holds; every stream supervisor label is a stream-supervisor. */
export const roleOf = (config, seat) => config.roles?.[seat] || (seat in (config.routing?.supervisors || {}) ? 'stream-supervisor'
  : Object.values(config.routing?.supervisors || {}).some(s => s.worker === seat) ? 'sbx-worker' : isTrustedReviewSeat(seat) ? 'trusted-reviewer' : null);

/**
 * @param readOnly the shadow runner serves the page and reads only; every write is refused
 * @param observed () => {units, prs} from the latest fleet and GitHub reads, for the views
 */
export function createApi({ store, config, gh = null, readPr = async () => null, now = () => new Date().toISOString(), readOnly = false, observed = () => ({}) }) {
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise((ok, bad) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) bad(new Error('Body too large.')); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error('Body is not JSON.')); } }); });

  async function act(seat, action, args) {
    const role = roleOf(config, seat);
    const why = role ? refusal(role, action, args, { seat, questions: store.state.questions }) : `"${seat || '(no seat)'}" is not a factory seat.`;
    if (why) return [403, { error: why }];
    const s = store.state;
    // A thread to resolve is a resolve_thread request on the dashboard, never a TB question (Alex, 11-09).
    if (action === 'ask' && !args.withdraw && /\bresolve\b[^?]*\bthreads?\b/i.test(args.title || '')) return [409, { error: 'Resolving a review thread is not a question: file it with resolve_thread (work, threadId, url, reviewer, ask, resolution) and Alex resolves it from the dashboard.' }];
    // One open question per record reaches Alex unless the asker says it's a separate decision (W-274).
    if (action === 'ask' && !args.withdraw && args.work && !args.distinct) {
      const open = Object.entries(s.questions).filter(([, q]) => q.work === args.work && q.status === 'open');
      if (open.length) return [409, { error: `${args.work} already has an open question: ${open.map(([id, q]) => `${id} "${q.title}" (from ${q.from})`).join('; ')}. Add to it instead, or pass distinct: true if this is a separate decision.` }];
    }
    if (action === 'route' && args.setOwner) args = { ...args, setOwnerOf: s.questions[args.id]?.work || undefined };
    // An ack or a create names the calling seat, never a claimed name.
    if (['ack', 'create'].includes(action)) args = { ...args, by: seat };
    let cmds = commandsFor(action, args);
    // Acking a request also closes the seat's inbox message about it.
    if (action === 'ack' && /^W-\d+\/R\d+$/.test(args.ref)) cmds = [...cmds, ...Object.values(s.messages).filter(m => m.to === seat && !m.ackedAt && [m.about?.requests].flat().includes(args.ref)).map(m => ({ kind: 'ack_message', target: m.id, payload: { outcome: args.outcome } }))];
    const ctx = { now: now(), by: seat };
    // Done and approval waits are checked against GitHub as it is now, not as last polled.
    const pr = ['done', 'await_approval'].includes(action) && (args.pr || s.work[args.work]?.links?.pr);
    const remote = pr ? await readPr(pr) : null;
    if (action === 'done' && args.assignmentId) Object.assign(ctx, { prHead: remote?.head || null, prState: remote });
    if (action === 'await_approval') ctx.verifiedPrs = remote ? [remote] : [];
    // A review can name a commit GitHub has but the poller hasn't read yet (W-231): read the PR, and if that commit is
    // its head, record the head first so the review lands on it.
    const rec = s.work[args.work];
    if (action === 'review' && rec?.links?.pr && args.head && args.head !== rec.head) {
      const live = await readPr(rec.links.pr);
      if (live?.head && (live.head.startsWith(args.head) || args.head.startsWith(live.head))) cmds = [{ kind: 'observe_head', target: rec.id, payload: { sha: live.head, via: 'github', isDraft: live.isDraft } }, ...cmds.map(c => c.payload?.type === 'review' ? { ...c, payload: { ...c.payload, head: live.head } } : c)];
    }
    // PR work whose PR was closed unmerged (Alex's call, e.g. TB-126 a) resolves once GitHub confirms it closed.
    if (action === 'resolve' && rec?.links?.pr && (await readPr(rec.links.pr))?.state === 'CLOSED')
      cmds = cmds.map(c => c.payload?.type === 'resolve' ? { ...c, payload: { ...c.payload, prClosed: rec.links.pr } } : c);
    return [200, { ok: true, results: store.appendAll(cmds, ctx) }];
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'Local requests only.' });
      const seat = req.headers['x-seat'];
      if (req.method === 'GET' && url.pathname === '/api/state') { const { work, questions, messages, seq } = store.state; return send(res, 200, { work, questions, messages, seq }); }
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(PAGE)); }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        const s = store.state, inbox = {};
        for (const m of Object.values(s.messages)) if (!m.ackedAt) inbox[m.to] = (inbox[m.to] || 0) + 1;
        const questions = Object.entries(s.questions).map(([id, q]) => ({ id, ...q })).filter(reachesAlex).map(({ id, title, work, recommend }) => ({ id, title, work, recommend }));
        const o = observed(), disk = Object.fromEntries((o.units || []).filter(u => o.health?.[u.id]).map(u => [u.supervisor?.label, o.health[u.id].diskPct]));
        return send(res, 200, { mode: readOnly ? 'shadow (read-only)' : 'live', seq: s.seq, buckets: config.buckets, questions, inbox,
          threads: Object.values(s.threads || {}).filter(t => t.status !== 'resolved').map(t => ({ ...t, title: s.work[t.work]?.title || null })),
          drain: Object.fromEntries(o.drain || []), disk, cards: boardView(s, { supervisors: Object.keys(config.routing?.supervisors || {}), ...o }) });
      }
      if (req.method === 'GET' && url.pathname === '/api/escapes') {
        const items = Object.values(store.state.work).flatMap(escapes), count = k => items.reduce((m, e) => ({ ...m, [e[k]]: (m[e[k]] || 0) + 1 }), {});
        return send(res, 200, { total: items.length, byReview: count('review'), byPr: count('pr'), items });
      }
      if (req.method === 'GET' && url.pathname === '/api/whoami') return send(res, 200, { ip: req.socket.remoteAddress, headers: req.headers });
      if (req.method === 'GET' && url.pathname === '/api/inbox') return send(res, 200, { seat, messages: Object.values(store.state.messages).filter(m => m.to === seat && !m.ackedAt) });
      if (req.method === 'POST' && url.pathname === '/api/threads/resolve') {
        if (req.headers['x-factory'] !== '1') return send(res, 403, { error: 'Missing x-factory header.' });
        if (readOnly || !gh) return send(res, 405, { error: 'This factory does not write to GitHub.' });
        const { ids = [] } = await readBody(req);
        return send(res, 200, { results: await resolveThreads(store, ids, gh, now) });
      }
      if (req.method === 'POST' && url.pathname === '/api/actions') {
        // A custom header a web page can't send cross-origin without a preflight this server never answers.
        if (req.headers['x-factory'] !== '1') return send(res, 403, { error: 'Missing x-factory header.' });
        if (readOnly) return send(res, 405, { error: 'This factory is read-only (shadow mode).' });
        const { action, args = {} } = await readBody(req);
        return send(res, ...await act(seat, action, args));
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 400, { error: e.message }); }
  };
}
