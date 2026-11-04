// Marking a PR ready on GitHub under Alex's standing authorization (config prReady.standing). Ported from V1 prReadyLocked.
// Confirmed means a readback showed the authorized head and isDraft=false; anything less is recorded, never assumed.
import { prReadyPreflight, gate } from '../core/work.mjs';
import { derivedCtx } from '../core/store.mjs';

const busy = new Set();
const BY = 'board (PR ready)';

/**
 * @param gh {view(url) → {head, isDraft} | null, ready(url)}
 * @returns {status, op?, reasons?}
 */
export async function markReady(store, id, gh, now = () => new Date().toISOString()) {
  if (busy.has(id)) return { status: 'busy' };
  busy.add(id);
  try { return await markReadyLocked(store, id, gh, now); } finally { busy.delete(id); }
}

async function markReadyLocked(store, id, gh, now) {
  const op = e => store.append({ kind: 'event', target: id, payload: { ...e, type: 'pr_ready_op' } }, { now: now(), by: BY });
  let w = store.state.work[id];
  const url = w.links?.pr, pinned = w.head;
  const done = w.prReadyOps.find(o => o.prUrl === url && o.head === pinned && o.status === 'confirmed');
  if (done) return { status: 'confirmed', op: done.id };
  const open = w.prReadyOps.find(o => ['inflight', 'uncertain'].includes(o.status));
  if (open) return { status: open.status, op: open.id };
  const remote = await gh.view(url).catch(() => null);
  w = store.state.work[id];
  if (w.links?.pr !== url || w.head !== pinned) return { status: 'changed' };
  const reasons = prReadyPreflight(w, remote, derivedCtx(store.state, id));
  if (reasons.length) return { status: 'refused', reasons };
  const opId = `P${w.prReadyOps.length + 1}`;
  if (remote.isDraft === false) { op({ opId, status: 'confirmed', head: pinned, prUrl: url, detail: 'GitHub already shows it ready at this head; no change made.' }); return { status: 'confirmed', op: opId }; }
  op({ opId, status: 'inflight', head: pinned, prUrl: url });
  // gh pr ready has no expected-SHA option, so a push can still land between the read and the mutation.
  let failed = null;
  try { await gh.ready(url); } catch (e) { failed = e.message; }
  const after = await gh.view(url).catch(() => null);
  const cur = store.state.work[id];
  const said = after ? (after.isDraft ? 'still draft' : `ready at ${after.head}`) : 'unreadable';
  if (cur.links?.pr !== url) { op({ opId, status: 'uncertain', detail: `The linked PR changed to ${cur.links?.pr || 'none'} during the operation; GitHub reports ${url} ${said}.` }); return { status: 'uncertain', op: opId }; }
  if (after && after.head !== pinned) {
    store.append({ kind: 'observe_head', target: id, payload: { sha: after.head, via: 'github', isDraft: after.isDraft } }, { now: now(), by: 'github' });
    op({ opId, status: 'uncertain', detail: `GitHub now shows ${after.head} (${after.isDraft ? 'draft' : 'ready'}), not the authorized ${pinned}. Not undone automatically.` });
    return { status: 'uncertain', op: opId };
  }
  const stillOk = cur.head === pinned && cur.prReadyAuth?.head === pinned && cur.prReadyAuth?.prUrl === url && gate(cur, derivedCtx(store.state, id)).ok;
  if (after && after.isDraft === false && stillOk) { op({ opId, status: 'confirmed', detail: `Readback: ready at ${pinned}.` }); return { status: 'confirmed', op: opId }; }
  if (after && after.isDraft === false) { op({ opId, status: 'uncertain', detail: `GitHub shows ready at ${pinned}, but the item's authorization or gate changed during the operation.` }); return { status: 'uncertain', op: opId }; }
  if (after && after.isDraft && failed) { op({ opId, status: 'failed', detail: failed }); return { status: 'failed', op: opId }; }
  op({ opId, status: 'uncertain', detail: failed || (after ? 'gh reported success but GitHub still shows a draft.' : 'Could not read the PR back.') });
  return { status: 'uncertain', op: opId };
}

/** Read-only: settle an inflight or uncertain attempt from what GitHub shows now. Never mutates GitHub. */
export async function reconcileReady(store, id, gh, now = () => new Date().toISOString()) {
  const w = store.state.work[id], o = w.prReadyOps.find(x => ['inflight', 'uncertain'].includes(x.status));
  if (!o) return null;
  const r = await gh.view(o.prUrl).catch(() => null);
  if (!r) return { status: o.status };
  const status = r.head === o.head && !r.isDraft ? 'confirmed' : r.head === o.head ? 'failed' : 'superseded';
  const detail = status === 'confirmed' ? `Reconciled: GitHub shows ready at ${o.head}.` : status === 'failed' ? `Reconciled: still draft at ${o.head}.` : `Reconciled: the PR is now at ${r.head}; this attempt no longer applies.`;
  store.append({ kind: 'event', target: id, payload: { type: 'pr_ready_op', opId: o.id, status, detail, observed: { head: r.head, isDraft: r.isDraft } } }, { now: now(), by: BY });
  return { status, op: o.id };
}

/** The standing-authorization tick: every ready_for_human record with a linked PR, outside Mutation. */
export async function autoReadyTick(store, gh, { standing, isMutation = () => false, now, log = () => {} }) {
  if (!standing) return;
  for (const w of Object.values(store.state.work).filter(x => x.phase === 'ready_for_human' && x.links?.pr && !isMutation(x))) {
    try {
      if (w.prReadyOps.some(o => ['inflight', 'uncertain'].includes(o.status))) { await reconcileReady(store, w.id, gh, now); continue; }
      if (w.prReadyOps.some(o => o.head === w.head && o.prUrl === w.links.pr && o.status === 'failed')) continue;
      if (w.prReadyAuth?.head !== w.head || w.prReadyAuth?.prUrl !== w.links.pr)
        store.append({ kind: 'event', target: w.id, payload: { type: 'authorize_pr_ready', prUrl: w.links.pr, head: w.head } }, { now: now(), by: `${standing.by} (standing, ${standing.at})` });
      const r = await markReady(store, w.id, gh, now);
      if (r.status !== 'confirmed') log(`auto ready ${w.id}: ${r.status}${r.reasons ? ` (${r.reasons.join(' ')})` : ''}`);
    } catch (e) { log(`auto ready ${w.id}: ${e.message}`); }
  }
}
