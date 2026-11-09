// The dashboard's Resolve button (Alex, 11-09): approve, check the thread on GitHub, resolve it, read it back.
const BY = 'Alex (dashboard)';

export async function resolveThreads(store, ids, gh, now) {
  const out = [];
  for (const id of ids) {
    const append = (kind, payload = {}) => store.append({ kind, target: id, payload }, { now: now(), by: kind === 'thread_approve' ? BY : 'board (thread resolve)' });
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
