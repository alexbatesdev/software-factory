// Which record a task or PR belongs to. Derived from the records themselves (source key + aliases), never stored apart.
import { prKey } from './units.mjs';
import { TERMINAL, PRE_QUEUE, trackOf } from './work.mjs';

/** key (tw-n, repo-n) → record id: each record's source, aliases and linked PR. */
export function sourceIndex(state) {
  const idx = new Map();
  const works = Object.values(state.work);
  // A record's own source outranks another's alias, which outranks a link: a task linking a PR never shadows the PR's record.
  // An absorbed placeholder's source now belongs to the record that absorbed it (via that record's alias).
  for (const keysOf of [w => w.completion?.absorbedInto ? [] : [w.source?.key], w => w.aliases || [], w => [prKey(w.links?.pr)]])
    for (const w of works) for (const k of keysOf(w)) if (k && !idx.has(k)) idx.set(k, w.id);
  return idx;
}

/** A record the poller made that nobody has taken up: safe to fold into the record that carries the work. */
export const isPlaceholder = w => w.source?.type === 'pr' && [...PRE_QUEUE, 'proposed'].includes(w.phase) && !(w.assignments || []).length && !w.owner;

// Branches name their Teamwork task last (alex/<area>/<slug>/<tw-id>).
const taskOfBranch = branch => { const m = String(branch || '').match(/\/(\d{6,})$/); return m ? `tw-${m[1]}` : null; };

// W-180: from this moment a PR also joins the one live record whose notes or assignments name its branch; older rows replay as decided.
export const BRANCH_IN_NOTES_FROM = '2026-11-05T20:00:00.000Z';
const LIVE = ['queued', 'started', 'blocked'];

/** The one live, PR-less record with a live assignment whose branch link, notes or assignment text name this exact branch. */
function namedBranchOwner(state, branch) {
  if (!branch || branch.length < 8) return null;
  const hits = Object.values(state.work).filter(w => !TERMINAL.includes(w.phase) && !w.links?.pr && (w.assignments || []).some(a => LIVE.includes(a.status))
    && (w.links?.branch === branch || JSON.stringify([w.updates.map(u => u.text), w.assignments.map(a => [a.brief, a.evidence])]).includes(branch)));
  return hits.length === 1 ? hits[0].id : null;
}

/**
 * The live record a newly seen source item should join instead of getting its own, if any.
 * @param now the row's time in the reducer (gates rules added later); omitted, only the original rules apply
 */
export function ownerOf(state, item, idx = sourceIndex(state), now = null) {
  if (idx.has(item.id)) return { id: idx.get(item.id), why: 'known' };
  const task = item.kind === 'pr' && idx.get(taskOfBranch(item.branch));
  if (task && !TERMINAL.includes(state.work[task].phase)) {
    // A task already carried by another PR never takes a second one; the new PR gets its own record to be sorted out.
    const other = prKey(state.work[task].links?.pr);
    if (other && other !== item.id) return null;
    return { id: task, why: `branch names ${taskOfBranch(item.branch)}` };
  }
  const named = item.kind === 'pr' && now && now >= BRANCH_IN_NOTES_FROM && namedBranchOwner(state, item.branch);
  if (named) return { id: named, why: `its notes name branch ${item.branch}` };
  return null;
}

/**
 * Who holds a PR link a record is about to take: null when free or already its own, a placeholder to absorb,
 * or a refusal naming the record that already carries it.
 */
export function claimPr(state, id, url, idx = sourceIndex(state)) {
  const key = prKey(url), holder = key && idx.get(key);
  if (!holder || holder === id) return null;
  const partners = new Set([...(state.work[id].related || []).filter(r => r.kind === 'same-work').map(r => r.to), state.work[id].parent]);
  if (partners.has(holder)) return null;
  if (isPlaceholder(state.work[holder])) return { absorb: holder, key };
  throw new Error(`${key} already belongs to ${holder}.`);
}

/** A record refreshed from its own source item: title, links, upstream and the task's acceptance criteria. */
// From here a task's description fills an empty objective (W-303: triage had nothing to read).
const OBJECTIVE_FROM = '2026-11-09T20:15:00.000Z';
export function refresh(w, item, parseAcs, now = '') {
  const acs = item.kind === 'task' ? parseAcs(item.description) : [];
  const next = { ...w, title: item.title, upstream: item.noFeedback ? 'gone' : 'open', repo: item.repo || w.repo,
    links: { ...w.links, source: item.url, ...(item.kind === 'pr' ? { pr: item.url, branch: item.branch } : {}) } };
  if (item.kind === 'task' && item.description && !w.objective && now >= OBJECTIVE_FROM) next.objective = item.description;
  if (item.support) next.support = true;
  if (acs.length && JSON.stringify(acs) !== JSON.stringify(w.acs?.items)) next.acs = { items: acs, source: `TW ${item.ref}` };
  return next;
}

/**
 * observe_source / source_gone commands for what changed between the records and one source's fresh read.
 * @param cfg {exclude}
 */
export function sourceCommands(state, items, sourceType, parseAcs, cfg = {}) {
  const idx = sourceIndex(state), cmds = [];
  for (const it of items.values()) {
    const o = ownerOf(state, it, idx), w = o && state.work[o.id];
    if (!w || w.source?.key !== it.id && !(w.aliases || []).includes(it.id) || w.source?.key === it.id && JSON.stringify(refresh(w, it, parseAcs, cfg.now ?? new Date().toISOString())) !== JSON.stringify(w)) cmds.push({ kind: 'observe_source', payload: it });
  }
  for (const w of Object.values(state.work)) {
    if (w.source?.type === sourceType && w.upstream === 'open' && !items.has(w.source.key)) cmds.push({ kind: 'source_gone', target: w.id, payload: {} });
  }
  return cmds;
}
