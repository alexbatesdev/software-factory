// Review threads Alex resolves from the dashboard (11-09): a seat files a complete request, Alex clicks, the factory
// resolves it on GitHub itself. Kept apart from questions so they never crowd the TB stream.
const fail = msg => { throw new Error(msg); };
export const THREAD_KINDS = ['thread_request', 'thread_approve', 'thread_op'];
const REQUIRED = ['work', 'threadId', 'url', 'reviewer', 'ask', 'resolution'];

/** Apply one thread row to state.threads in place; returns the RT id. */
export function foldThread(state, { kind, target, payload: p, ctx }) {
  if (kind === 'thread_request') {
    for (const k of REQUIRED) if (!p[k]) fail(`A resolve request needs "${k}".`);
    const w = state.work[p.work] || fail(`There is no work item ${p.work}.`);
    if (!w.links?.pr) fail(`${p.work} has no linked PR.`);
    // The id must be one the GitHub poll reported on this record, so the click can't resolve a stranger's thread.
    if (!(w.findings || []).some(f => f.source?.type === 'threads' && f.source.ids?.includes(p.threadId))) fail(`GitHub never reported thread ${p.threadId} on ${p.work}'s PR.`);
    const dup = Object.entries(state.threads).find(([, t]) => t.threadId === p.threadId && t.status !== 'failed');
    if (dup) fail(`${p.threadId} is already requested as ${dup[0]}.`);
    const id = `RT-${state.nextThread++}`;
    state.threads[id] = { id, work: p.work, pr: w.links.pr, threadId: p.threadId, url: p.url, reviewer: p.reviewer, ask: String(p.ask).slice(0, 500), resolution: String(p.resolution).slice(0, 1000), status: 'requested', from: ctx.by, at: ctx.now, approvedBy: null, approvedAt: null, detail: null };
    return id;
  }
  const t = state.threads[target] || fail(`There is no thread request ${target}.`);
  if (kind === 'thread_approve') {
    if (!['requested', 'failed'].includes(t.status)) fail(`${target} is ${t.status}.`);
    state.threads[target] = { ...t, status: 'approved', approvedBy: ctx.by, approvedAt: ctx.now };
  } else {
    if (!['resolved', 'failed'].includes(p.status)) fail('A thread outcome is resolved or failed.');
    state.threads[target] = { ...t, status: p.status, detail: p.detail || null, doneAt: ctx.now };
  }
  return target;
}
