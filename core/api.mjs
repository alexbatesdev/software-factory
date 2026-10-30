// The factory's HTTP API: every write is a board action, checked against the caller's role, appended atomically.
// The caller's seat comes from the x-seat header, which the MCP server fills from its pane. ponytail: trusted because
// only local processes reach 127.0.0.1; a cloud deployment needs factory-issued seat tokens instead.
import { refusal } from './capabilities.mjs';
import { commandsFor } from './actions.mjs';

/** The role a seat label holds; every stream supervisor label is a stream-supervisor. */
export const roleOf = (config, seat) => config.roles?.[seat] || (seat in (config.routing?.supervisors || {}) ? 'stream-supervisor' : null);

export function createApi({ store, config, readPr = async () => null, now = () => new Date().toISOString() }) {
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise((ok, bad) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) bad(new Error('Body too large.')); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error('Body is not JSON.')); } }); });

  async function act(seat, action, args) {
    const role = roleOf(config, seat);
    const why = role ? refusal(role, action, args) : `"${seat || '(no seat)'}" is not a factory seat.`;
    if (why) return [403, { error: why }];
    const s = store.state;
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
    return [200, { ok: true, results: store.appendAll(cmds, ctx) }];
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'Local requests only.' });
      const seat = req.headers['x-seat'];
      if (req.method === 'GET' && url.pathname === '/api/state') { const { work, questions, messages, seq } = store.state; return send(res, 200, { work, questions, messages, seq }); }
      if (req.method === 'GET' && url.pathname === '/api/inbox') return send(res, 200, { seat, messages: Object.values(store.state.messages).filter(m => m.to === seat && !m.ackedAt) });
      if (req.method === 'POST' && url.pathname === '/api/actions') {
        // A custom header a web page can't send cross-origin without a preflight this server never answers.
        if (req.headers['x-factory'] !== '1') return send(res, 403, { error: 'Missing x-factory header.' });
        const { action, args = {} } = await readBody(req);
        return send(res, ...await act(seat, action, args));
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) { return send(res, 400, { error: e.message }); }
  };
}
