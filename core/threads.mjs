// Review threads Alex resolves from the dashboard (11-09): a seat files a complete request, Alex clicks, the factory
// resolves it on GitHub itself. Kept apart from questions so they never crowd the TB stream.
const fail = msg => { throw new Error(msg); };
export const THREAD_KINDS = ['thread_request', 'thread_approve', 'thread_op', 'thread_check'];
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
    if (p.fixSha != null && !/^[0-9a-f]{7,40}$/i.test(p.fixSha)) fail('fixSha is the fix commit\'s SHA (7 to 40 hex characters).');
    const id = `RT-${state.nextThread++}`;
    state.threads[id] = { id, work: p.work, pr: w.links.pr, threadId: p.threadId, url: p.url, reviewer: p.reviewer, ask: String(p.ask).slice(0, 500), resolution: String(p.resolution).slice(0, 1000), fixSha: p.fixSha ? String(p.fixSha).toLowerCase() : null, status: 'requested', from: ctx.by, at: ctx.now, approvedBy: null, approvedAt: null, detail: null };
    return id;
  }
  const t = state.threads[target] || fail(`There is no thread request ${target}.`);
  // The factory's last reading of the resolve checks (Alex, 11-20), shown on the dashboard.
  if (kind === 'thread_check') { state.threads[target] = { ...t, checks: { ready: !!p.ready, failed: p.failed || [], at: ctx.now } }; return target; }
  if (kind === 'thread_approve') {
    if (!['requested', 'failed'].includes(t.status)) fail(`${target} is ${t.status}.`);
    state.threads[target] = { ...t, status: 'approved', approvedBy: ctx.by, approvedAt: ctx.now };
  } else {
    // dismissed: its PR merged or closed, so there is nothing left to resolve (Alex, 11-11).
    if (!['resolved', 'failed', 'dismissed'].includes(p.status)) fail('A thread outcome is resolved, failed or dismissed.');
    state.threads[target] = { ...t, status: p.status, detail: p.detail || null, doneAt: ctx.now };
  }
  return target;
}

export const CODEX = 'chatgpt-codex-connector';

/**
 * Whether the factory may resolve a thread itself (Alex, 11-20, option c). Codex doesn't re-review after a push, so its
 * threads need the fix commit only; a person's thread also needs the asker's acceptance. A reply with no fix commit
 * settles a person's thread only by their approval, and a codex thread never: that stays Alex's click.
 * @param facts {first, path, comments: [{by, at, thumbsBy}], fix: {onPr, files, index} | null, approvals: [{by, state, at, index}]}
 *   `index` is a commit's position in the PR's commit list, so "includes the fix" is index >= fix.index.
 * @returns {ready, failed: [why]}
 */
export function threadGate({ me, fixSha }, { first, path, comments = [], fix, approvals = [] }) {
  const failed = [], codex = first === CODEX, mine = comments.filter(c => c.by === me).at(-1), last = comments.at(-1);
  if (!mine) failed.push("we haven't replied on the thread");
  else if (last.by !== me) failed.push(`${last.by} replied after us, so the thread is live again`);
  if (fixSha) {
    if (!fix?.onPr) failed.push(`fix commit ${fixSha.slice(0, 7)} isn't on the PR`);
    else if (path && !fix.files.includes(path)) failed.push(`fix commit ${fixSha.slice(0, 7)} doesn't change ${path}`);
  } else if (codex) failed.push("no fix commit: a reply alone on a codex thread is Alex's click");
  if (!codex && mine) {
    const latest = approvals.filter(a => a.by === first).sort((a, b) => a.at.localeCompare(b.at)).at(-1);
    const approved = latest?.state === 'APPROVED' && (fixSha ? fix?.index != null && latest.index >= fix.index : latest.at > mine.at);
    if (!(mine.thumbsBy || []).includes(first) && !approved) failed.push(`${first} hasn't accepted it (a 👍 on our reply, or an approval that includes the fix)`);
  }
  return { ready: !failed.length, failed };
}
