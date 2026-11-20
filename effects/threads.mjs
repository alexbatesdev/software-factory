import { threadGate } from '../core/threads.mjs';
// The dashboard's Resolve button (Alex, 11-09): approve, check the thread on GitHub, resolve it, read it back.
const BY = 'Alex (dashboard)';

export async function resolveThreads(store, ids, gh, now, by = BY) {
  const out = [];
  for (const id of ids) {
    const append = (kind, payload = {}) => store.append({ kind, target: id, payload }, { now: now(), by: kind === 'thread_approve' ? by : 'factory (thread resolve)' });
    const result = status => { out.push({ id, status, detail: store.state.threads[id]?.detail || null }); };
    try {
      append('thread_approve');
      const t = store.state.threads[id];
      const before = await gh.thread(t.threadId);
      if (!before) { append('thread_op', { status: 'failed', detail: `GitHub has no review thread ${t.threadId}.` }); result('failed'); continue; }
      if (before.pr !== t.pr) { append('thread_op', { status: 'failed', detail: `${t.threadId} is on ${before.pr}, not ${t.pr}; nothing written.` }); result('failed'); continue; }
      if (!before.isResolved) await gh.resolveThread(t.threadId);
      const after = await gh.thread(t.threadId);
      append('thread_op', after?.isResolved ? { status: 'resolved', detail: before.isResolved ? 'Already resolved on GitHub.' : 'Resolved on GitHub (read back).' } : { status: 'failed', detail: 'GitHub still shows it unresolved after the call.' });
      result(store.state.threads[id].status);
    } catch (e) {
      if (store.state.threads[id]?.status === 'approved') append('thread_op', { status: 'failed', detail: e.message.slice(0, 300) });
      out.push({ id, status: 'failed', detail: e.message.slice(0, 300) });
    }
  }
  return out;
}

const AUTO = 'factory (auto: checks passed)';

/**
 * Requests whose thread was resolved on GitHub close as resolved; the rest are checked (Alex, 11-20: the factory resolves
 * a thread once threadGate passes, and Alex's click stays the override). At most `limit` threads per call.
 */
export async function syncResolvedThreads(store, gh, now, { me, limit = 20, prState = () => null } = {}) {
  // A request on a PR that merged or closed is dismissed, with no GitHub read or write (Alex, 11-11).
  for (const t of Object.values(store.state.threads).filter(t => ['requested', 'failed'].includes(t.status))) {
    const st = prState(t.pr);
    if (['MERGED', 'CLOSED'].includes(st)) store.append({ kind: 'thread_op', target: t.id, payload: { status: 'dismissed', detail: `Dismissed: ${t.pr} was ${st.toLowerCase()} before it was resolved.` } }, { now: now(), by: 'factory (thread sync)' });
  }
  const open = Object.values(store.state.threads).filter(t => ['requested', 'failed'].includes(t.status)).slice(0, limit);
  const prFacts = new Map(); // one PR read per sync, shared by its threads
  for (const t of open) {
    const th = await gh.threadFacts(t.threadId).catch(() => null);
    if (th?.isResolved) { store.append({ kind: 'thread_op', target: t.id, payload: { status: 'resolved', detail: 'Resolved on GitHub directly.' } }, { now: now(), by: 'factory (thread sync)' }); continue; }
    if (!th || t.status !== 'requested' || !me) continue;
    const key = `${t.pr} ${t.fixSha}`;
    if (!prFacts.has(key)) prFacts.set(key, await Promise.all([t.fixSha ? gh.fixFacts(t.pr, t.fixSha) : null, gh.reviews(t.pr)]).catch(() => null));
    const read = prFacts.get(key);
    if (!read) continue;
    const [fix, reviews] = read, at = sha => fix?.shas ? fix.shas.findIndex(x => x === sha) : -1;
    const gate = threadGate({ me, fixSha: t.fixSha }, { ...th, fix, approvals: reviews.map(r => ({ by: r.login, state: r.state, at: r.at || '', index: at(r.commit) })) });
    if (JSON.stringify(t.checks?.failed) !== JSON.stringify(gate.failed)) store.append({ kind: 'thread_check', target: t.id, payload: gate }, { now: now(), by: 'factory (thread sync)' });
    if (gate.ready) await resolveThreads(store, [t.id], gh, now, AUTO);
  }
}
