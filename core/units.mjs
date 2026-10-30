// PR work units: once tasks are implemented in a PR, the PR's record is the unit that groups them, and follow-up
// work hangs off it as children. Membership is derived from links, coverage and relations; nothing else stores it. Pure.
import { TERMINAL } from './work.mjs';

/** `repo-n` for a GitHub PR URL, the key the board files PRs under. */
export const prKey = url => { const m = String(url || '').match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/); return m ? `${m[1]}-${m[2]}` : null; };

/** The PR-shaped record that holds its PR's key: a poller PR record, an agent-filed PR record, or PR feedback. */
export function isPrUnit(w, bySource) {
  if (!w) return false;
  const k = w.source?.type === 'pr' ? w.source.key : prKey(w.links?.pr);
  return !!k && bySource[k] === w.id && (['pr', 'agent'].includes(w.source?.type) || w.kind === 'pr-feedback');
}

/** The units a task is implemented in: the PR it links, PRs in its open-pr coverage, and same-work PR records. */
export function unitsOf(w, works, bySource) {
  if (!w || isPrUnit(w, bySource)) return [];
  const urls = [w.links?.pr, ...(w.coverage?.state === 'open-pr' ? (w.coverage.prs || []).map(p => p.url) : [])].filter(Boolean);
  const ids = new Set();
  for (const u of urls) { const id = bySource[prKey(u)]; if (id && id !== w.id && isPrUnit(works[id], bySource)) ids.add(id); }
  for (const r of w.related || []) if (r.kind === 'same-work' && isPrUnit(works[r.to], bySource)) ids.add(r.to);
  return [...ids];
}

/** One pass over the board: members and children per unit, and units per task. */
export function groupIndex(works, bySource) {
  const members = {}, children = {}, units = {};
  for (const w of Object.values(works)) {
    const us = unitsOf(w, works, bySource);
    if (us.length) units[w.id] = us;
    for (const u of us) (members[u] ||= []).push(w.id);
    if (w.parent && works[w.parent]) (children[w.parent] ||= []).push(w.id);
  }
  return { members, children, unitsOf: units };
}

/**
 * Records a merge finishes: a unit whose PR merged, and a task once every unit it's in has merged.
 * A recorded wait, an open question or Mutation keeps a record open; merged ≠ every requirement met for those.
 * @param ctx {prState: url => 'OPEN'|'MERGED'|'CLOSED'|null, openQuestions: id => n, track: w => 'mutation'|...}
 */
export function mergeCloses(works, bySource, { prState, openQuestions, track }) {
  const g = groupIndex(works, bySource), out = [];
  // Partial or unknown coverage means work is left beyond the PR, so a merge doesn't finish it.
  const live = w => w && !TERMINAL.includes(w.phase) && !w.waitingOn && !openQuestions(w.id) && track(w) !== 'mutation' && !['partial', 'unknown', 'none'].includes(w.coverage?.state);
  const merged = id => prState(works[id].links?.pr) === 'MERGED';
  for (const w of Object.values(works)) {
    if (!live(w)) continue;
    if (isPrUnit(w, bySource) && merged(w.id)) out.push({ id: w.id, prs: [w.links.pr] });
    const us = g.unitsOf[w.id] || [];
    if (us.length && us.every(merged)) out.push({ id: w.id, prs: us.map(u => works[u].links.pr) });
  }
  return out;
}
