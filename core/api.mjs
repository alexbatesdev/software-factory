// The factory's HTTP API: every write is a board action, checked against the caller's role, appended atomically.
// The caller's seat comes from the x-seat header, which the MCP server fills from its pane. ponytail: trusted because
// only local processes reach 127.0.0.1; a cloud deployment needs factory-issued seat tokens instead.
import { refusal, isTrustedReviewSeat, ROLES } from './capabilities.mjs';
import { commandsFor } from './actions.mjs';
import { readFileSync } from 'node:fs';
import { boardView } from '../views/board.mjs';
import { reachesAlex } from './derive.mjs';
import { supportOf, prGateView } from './store.mjs';
import { decideTaskRequests, STUCK_MS } from './task-requests.mjs';
import { decideAwsRequests } from './aws-access.mjs';
import { escapes, needsPrApproval, awaitsPrApproval, wouldAwaitPrApproval } from './work.mjs';
import { resolveThreads } from '../effects/threads.mjs';
import { toolsFor } from '../mcp/server.mjs';

const PAGE = new URL('../views/index.html', import.meta.url);
const VENDOR = ['marked-12.0.2.min.js', 'purify-3.1.6.min.js'];

/** The role a seat label holds; every stream supervisor label is a stream-supervisor. */
export const roleOf = (config, seat) => config.roles?.[seat] || (seat in (config.routing?.supervisors || {}) ? 'stream-supervisor'
  : Object.values(config.routing?.supervisors || {}).some(s => s.worker === seat) ? 'sbx-worker' : isTrustedReviewSeat(seat) ? 'trusted-reviewer' : null);

/**
 * @param readOnly the shadow runner serves the page and reads only; every write is refused
 * @param observed () => {units, prs} from the latest fleet and GitHub reads, for the views
 */
export function createApi({ store, config, gh = null, tw = null, awsHost = null, onMain = null, readPr = async () => null, now = () => new Date().toISOString(), readOnly = false, observed = () => ({}) }) {
  const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = req => new Promise((ok, bad) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) bad(new Error('Body too large.')); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { bad(new Error('Body is not JSON.')); } }); });

  // Alex's optional note on a dashboard decision (W-423): his words, verbatim, on the record; the inbox delivers it.
  const alexNote = (work, note, what) => { if (work && String(note || '').trim()) store.append({ kind: 'event', target: work, payload: { type: 'note', text: `${what}: ${String(note).trim()}` } }, { now: now(), by: 'Alex (dashboard)' }); };

  async function act(seat, action, args) {
    const role = roleOf(config, seat);
    const why = role ? refusal(role, action, args, { seat, questions: store.state.questions }) : `"${seat || '(no seat)'}" is not a factory seat.`;
    if (why) return [403, { error: why }];
    const s = store.state, asking = action === 'ask' && !args.withdraw && !args.amend;
    // A discovery split out as pre-existing must show the faulty code on origin/main, checked here (W-435: W-434's
    // "pre-existing on main" was code the PR under review introduced). Otherwise the PR under review fixes it.
    if (action === 'progress' && args.discovery && /pre-?existing|\bon (origin\/)?main\b|already (on|in) main/i.test(`${args.discovery} ${args.text || ''}`)) {
      const m = args.onMain;
      if (!m?.sha || !m?.path || !String(m?.code || '').trim()) return [409, { error: 'A discovery called pre-existing needs onMain: {sha (on origin/main), path, code (a line of the faulty code, verbatim)}. Check origin/main first; if the code only exists on the PR under review, fix it in that PR instead of splitting it out.' }];
      const repo = s.work[args.work]?.repo || 'built-rails';
      if (onMain && !(await onMain(repo, m).catch(() => false))) return [409, { error: `That code isn't on origin/main: "${m.code}" isn't in ${m.path} at ${m.sha}, or ${m.sha} isn't on origin/main. If the PR under review introduced it, fix it there.` }];
    }
    // A message waits in an inbox until acked, so it goes only to a seat that can read and ack one (W-414).
    if (action === 'message' && !ROLES[roleOf(config, args.to)]?.includes('ack')) return [409, { error: `${args.to} can't read or ack factory messages (no board role with ack); reach it another way.` }];
    // A thread to resolve is a resolve_thread request on the dashboard, never a TB question (Alex, 11-09).
    if (asking && /\bresolve\b[^?]*\bthreads?\b/i.test(args.title || '')) return [409, { error: 'Resolving a review thread is not a question: file it with resolve_thread (work, threadId, url, reviewer, ask, resolution) and Alex resolves it from the dashboard.' }];
    // Factual PR-description fixes go through without asking (Alex, 11-09, W-212); a scope change is still a question.
    if (asking && /\bPR[- ](body|description)\b/i.test(args.title || '')) return [409, { error: 'A factual PR-description fix (making the body true again, no scope change) is not a question: apply it yourself and put the before/after in your progress note. If it changes scope, ask with distinct wording (the decision, not the edit).' }];
    // One open question per record reaches Alex unless the asker says it's a separate decision (W-274).
    if (asking && args.work && !args.distinct) {
      const open = Object.entries(s.questions).filter(([, q]) => q.work === args.work && q.status === 'open');
      if (open.length) return [409, { error: `${args.work} already has an open question: ${open.map(([id, q]) => `${id} "${q.title}" (from ${q.from})`).join('; ')}. Add to it with ask amend: ${open[0][0]} and a note, or pass distinct: true if this is a separate decision.` }];
    }
    // Code work is done only against Benny's Definition of Done (Alex, 11-09): the worker's exit report, checked by the supervisor.
    if (action === 'done' && args.replacesPr && s.work[args.work]?.links?.pr !== args.replacesPr) return [409, { error: `replacesPr names the PR ${args.work} carries now: ${s.work[args.work]?.links?.pr || 'none'}.` }];
    const exitReport = action === 'done' && !args.noChange && s.work[args.work]?.assignments?.find(x => x.id === args.assignmentId)?.kind !== 'review';
    if (exitReport) {
      const miss = ['changed', 'proven', 'unverified', 'risk'].filter(k => !args.report?.[k]);
      if (miss.length) return [400, { error: `Record done with the worker's exit report (report: {changed, proven, unverified, risk}; missing ${miss.join(', ')}), checked against ~/Code/plans/standards/DEFINITION_OF_DONE.md "Not done if". If an item fails, brief fixes instead. "unverified" may be "nothing".` }];
    }
    if (action === 'triage' && args.carriesOut && !['answered', 'settled'].includes(s.questions[args.carriesOut]?.status)) return [409, { error: `carriesOut names a question Alex has answered; ${args.carriesOut} is ${s.questions[args.carriesOut]?.status || 'not a question'}.` }];
    // Alex's decision already has a question: a second, prose wait on him never clears when he answers (W-365: W-271).
    const asked = action === 'progress' && !args.assignmentId && args.actor === 'alex' && args.waitingOn && args.waitingOn !== 'clear'
      && Object.entries(s.questions).find(([, q]) => q.status === 'open' && q.work === args.work);
    if (asked) return [409, { error: `${args.work} already waits on Alex's ${asked[0]} ("${asked[1].title}"). Block the assignment on ${asked[0]} instead (progress stage blocked, waitingOn ${asked[0]}): it resumes when he answers.` }];
    const parking = action === 'triage' && args.bucket === 'intake' && s.work[args.work];
    const seats = [...Object.keys(config.routing?.supervisors || {}), ...Object.keys(config.roles || {}), config.boardLead?.seat || 'board lead'];
    if (action === 'triage' && args.reviewBy && !seats.includes(args.reviewer)) return [409, { error: `reviewer must be a seat that reads its inbox: ${seats.join(', ')}.` }];
    const kept = parking && (parking.externalDeps || []).filter(d => (d.text || d.ref) !== args.releaseHold);
    if (parking && !kept.length && !parking.waitingOn && !['untilMerged', 'untilAnswered', 'reviewBy', 'deferredTo'].some(k => args[k]))
      return [409, { error: `Parking ${args.work} in intake needs what releases it: untilMerged (#N), untilAnswered (TB-n), reviewBy (YYYY-MM-DD) with reviewer (the seat that looks again), or deferredTo (who decides, e.g. product).` }];
    // Ready into New PRs only with the breakdown Alex reads there (11-09).
    const tw = action === 'triage' && args.bucket === 'ready' && s.work[args.work];
    if (tw && !tw.proposal && !args.proposal && args.support !== true && !String(args.alexAsked || '').trim() && wouldAwaitPrApproval(prGateView(s, { ...tw, carriesOut: [...(tw.carriesOut || []), ...(args.carriesOut ? [args.carriesOut] : [])] }), config.prApproval)) return [409, { error: `${args.work} will wait in Alex's New PRs list, so triage it ready with a proposal: {prompted (what made the agent file it), addresses (what the PR fixes), whyThisFix (why this is the right fix), since (how long the issue has existed, with evidence), customerImpact (what changes for existing customers, or "none")}.` }];
    // A new PR nobody asked for starts only after Alex's dashboard click (Alex, 11-09), whoever assigns it.
    if (action === 'assign' && args.kind !== 'review' && s.work[args.work] && needsPrApproval(prGateView(s, s.work[args.work]), config.prApproval)) return [409, { error: `${args.work} would open a new PR that no Teamwork task asked for: it waits for Alex's go on the dashboard (New PRs). Don't ask it as a question.` }];
    if (action === 'route' && args.setOwner) args = { ...args, setOwnerOf: s.questions[args.id]?.work || undefined };
    // An ack or a create names the calling seat, never a claimed name.
    if (['ack', 'create'].includes(action)) args = { ...args, by: seat };
    let cmds = commandsFor(action, args);
    // Acking a request also closes the seat's inbox message about it.
    if (action === 'ack' && /^W-\d+\/R\d+$/.test(args.ref)) cmds = [...cmds, ...Object.values(s.messages).filter(m => m.to === seat && !m.ackedAt && [m.about?.requests].flat().includes(args.ref)).map(m => ({ kind: 'ack_message', target: m.id, payload: { outcome: args.outcome } }))];
    const ctx = { now: now(), by: seat };
    // Done and approval waits are checked against GitHub as it is now, not as last polled.
    // One fixes round per PR (W-377): a second one on a PR another record is already fixing is refused.
    const pr8 = action === 'assign' && args.kind === 'fixes' && s.work[args.work]?.links?.pr;
    const fixing = pr8 && Object.values(s.work).flatMap(o => o.id !== args.work && o.links?.pr === pr8 ? (o.assignments || []).filter(a => a.kind === 'fixes' && ['queued', 'started'].includes(a.status)).map(a => `${o.id} ${a.id}`) : [])[0];
    if (fixing) return [409, { error: `${pr8} is already being fixed by ${fixing}; add to that round instead of starting a second one.` }];
    const closing = action === 'triage' && args.bucket === 'close';
    const pr = (['done', 'await_approval'].includes(action) || closing) && (args.pr || s.work[args.work]?.links?.pr);
    const remote = pr ? await readPr(pr) : null;
    if (closing) ctx.prState = remote;
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
    if (exitReport) { const r = args.report; cmds = [...cmds, { kind: 'event', target: args.work, payload: { type: 'exit_report', assignmentId: args.assignmentId, version: args.expectedVersion, head: args.head, changed: r.changed, proven: r.proven, unverified: r.unverified, risk: r.risk } }]; }
    return [200, { ok: true, results: store.appendAll(cmds, ctx) }];
  }

  return async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return send(res, 403, { error: 'Local requests only.' });
      const seat = req.headers['x-seat'];
      if (req.method === 'GET' && url.pathname === '/api/state') { const { work, questions, messages, seq } = store.state; return send(res, 200, { work, questions, messages, seq }); }
      // Vendored page libraries (markdown for review-thread messages), by exact name only.
      const vendor = req.method === 'GET' && /^\/vendor\/([\w.-]+\.js)$/.exec(url.pathname)?.[1];
      if (vendor && VENDOR.includes(vendor)) { res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=86400' }); return res.end(readFileSync(new URL(`../views/vendor/${vendor}`, import.meta.url))); }
      if (req.method === 'GET' && url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(readFileSync(PAGE)); }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        const s = store.state, inbox = {};
        for (const m of Object.values(s.messages)) if (!m.ackedAt) inbox[m.to] = (inbox[m.to] || 0) + 1;
        const questions = Object.entries(s.questions).map(([id, q]) => ({ id, ...q })).filter(reachesAlex).map(({ id, title, work, recommend, amendments }) => ({ id, title, work, recommend, amendments: amendments || [], support: supportOf(s, work) }));
        const o = observed(), disk = Object.fromEntries((o.units || []).filter(u => o.health?.[u.id]).map(u => [u.supervisor?.label, o.health[u.id].diskPct]));
        return send(res, 200, { mode: readOnly ? 'shadow (read-only)' : 'live', seq: s.seq, buckets: config.buckets, questions, inbox,
          newPrs: Object.values(s.work).filter(w => awaitsPrApproval(prGateView(s, w), config.prApproval)).map(w => ({ id: w.id, title: w.title, objective: w.objective || null, from: w.proposedFrom || w.source?.by || w.source?.type || null, repo: w.repo || null, support: supportOf(s, w.id), proposal: w.proposal || null })),
          awsRequests: Object.values(s.awsRequests || {}).filter(r => ['requested', 'approved', 'failed'].includes(r.status)).map(r => ({ ...r, title: s.work[r.work]?.title || null, support: supportOf(s, r.work) })),
          taskRequests: Object.values(s.taskRequests || {}).filter(t => ['requested', 'approved', 'failed'].includes(t.status)).map(t => ({ ...t, stuck: t.status === 'approved' && Date.parse(now()) - Date.parse(t.approvedAt) > STUCK_MS, title: s.work[t.work]?.title || null, support: supportOf(s, t.work) })),
          threads: Object.values(s.threads || {}).filter(t => !['resolved', 'dismissed'].includes(t.status)).map(t => ({ ...t, title: s.work[t.work]?.title || null, support: supportOf(s, t.work) })),
          drain: Object.fromEntries(o.drain || []), disk, supportPause: s.supportPause || null, cards: boardView(s, { supervisors: Object.keys(config.routing?.supervisors || {}), prApproval: config.prApproval, githubOwner: config.githubOwner, ...o }) });
      }
      if (req.method === 'GET' && url.pathname === '/api/escapes') {
        const items = Object.values(store.state.work).flatMap(escapes), count = k => items.reduce((m, e) => ({ ...m, [e[k]]: (m[e[k]] || 0) + 1 }), {});
        return send(res, 200, { total: items.length, byReview: count('review'), byPr: count('pr'), items });
      }
      if (req.method === 'GET' && url.pathname === '/api/tools') return send(res, 200, toolsFor(roleOf(config, seat)));
      if (req.method === 'GET' && url.pathname === '/api/whoami') return send(res, 200, { ip: req.socket.remoteAddress, headers: req.headers });
      if (req.method === 'GET' && url.pathname === '/api/inbox') return send(res, 200, { seat, messages: Object.values(store.state.messages).filter(m => m.to === seat && !m.ackedAt) });
      const tc = req.method === 'GET' && url.pathname.match(/^\/api\/threads\/(RT-\d+)\/comments$/);
      if (tc) {
        const t = store.state.threads?.[tc[1]];
        if (!t) return send(res, 404, { error: `There is no thread request ${tc[1]}.` });
        if (!gh?.threadComments) return send(res, 405, { error: 'This factory does not read GitHub.' });
        return send(res, 200, { comments: (await gh.threadComments(t.threadId)).map(c => ({ ...c, mine: c.by === config.githubLogin })) });
      }
      if (req.method === 'POST' && url.pathname === '/api/threads/resolve') {
        if (req.headers['x-factory'] !== '1') return send(res, 403, { error: 'Missing x-factory header.' });
        if (readOnly || !gh) return send(res, 405, { error: 'This factory does not write to GitHub.' });
        const { ids = [], note = null } = await readBody(req);
        const results = await resolveThreads(store, ids, gh, now);
        for (const w of new Set(ids.map(id => store.state.threads[id]?.work))) alexNote(w, note, 'Alex, resolving its review threads');
        return send(res, 200, { results });
      }
      if (req.method === 'POST' && url.pathname === '/api/support-pause') {
        if (req.headers['x-factory'] !== '1') return send(res, 403, { error: 'Missing x-factory header.' });
        if (readOnly) return send(res, 405, { error: 'This factory does not write.' });
        const { paused } = await readBody(req);
        store.append({ kind: 'support_pause', payload: { paused: !!paused } }, { now: now(), by: 'Alex (dashboard)' });
        return send(res, 200, { supportPause: store.state.supportPause });
      }
      if (req.method === 'POST' && url.pathname === '/api/aws-requests') {
        if (req.headers['x-factory'] !== '1') return send(res, 403, { error: 'Missing x-factory header.' });
        if (readOnly) return send(res, 405, { error: 'This factory does not write.' });
        const { ids = [], decision, note } = await readBody(req);
        if (!['approve', 'decline'].includes(decision)) return send(res, 400, { error: 'decision is approve or decline.' });
        const results = await decideAwsRequests(store, ids, decision, note, awsHost, now);
        if (decision === 'approve') for (const id of ids) alexNote(store.state.awsRequests[id]?.work, note, `Alex, approving AWS access ${id}`);
        return send(res, 200, { results });
      }
      if (req.method === 'POST' && url.pathname === '/api/task-requests') {
        if (req.headers['x-factory'] !== '1') return send(res, 403, { error: 'Missing x-factory header.' });
        if (readOnly) return send(res, 405, { error: 'This factory is read-only (shadow mode).' });
        const { ids = [], decision, note = null } = await readBody(req);
        if (!['approve', 'decline'].includes(decision)) return send(res, 400, { error: 'decision is approve or decline.' });
        const results = await decideTaskRequests(store, ids, decision, note, tw, now);
        if (decision === 'approve') for (const id of ids) alexNote(store.state.taskRequests[id]?.work, note, `Alex, approving Teamwork task ${id}`);
        return send(res, 200, { results });
      }
      if (req.method === 'POST' && url.pathname === '/api/pr-approvals') {
        if (req.headers['x-factory'] !== '1') return send(res, 403, { error: 'Missing x-factory header.' });
        if (readOnly) return send(res, 405, { error: 'This factory is read-only (shadow mode).' });
        const { ids = [], decision, note = null } = await readBody(req);
        if (!['approve', 'decline'].includes(decision)) return send(res, 400, { error: 'decision is approve or decline.' });
        const why = String(note || '').trim();
        const results = ids.map(id => { try {
          store.append({ kind: 'event', target: id, payload: decision === 'approve' ? { type: 'pr_approved' } : { type: 'withdraw', note: `Alex declined opening a new PR for it (dashboard)${why ? `: ${why}` : '.'}` } }, { now: now(), by: 'Alex (dashboard)' });
          if (decision === 'approve') alexNote(id, why, 'Alex, approving the new PR, with instructions');
          return { id, ok: true };
        } catch (e) { return { id, error: e.message }; } });
        return send(res, 200, { results });
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
