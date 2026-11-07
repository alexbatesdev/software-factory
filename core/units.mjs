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
  // Alex's merge is his decision, so a wait or open question doesn't hold the record open (W-248); it is named in the close.
  const live = w => w && !TERMINAL.includes(w.phase) && track(w) !== 'mutation';
  const merged = id => prState(works[id].links?.pr) === 'MERGED';
  for (const w of Object.values(works)) {
    if (!live(w)) continue;
    const n = openQuestions(w.id), outstanding = [w.waitingOn && `waiting on ${w.waitingOn.who}: ${w.waitingOn.what}`, n && `${n} open question(s)`].filter(Boolean);
    // Partial or unknown coverage means work is left beyond the PR: raised to Alex, not closed.
    const c = { id: w.id, outstanding, ...(['partial', 'unknown', 'none'].includes(w.coverage?.state) && { raise: true }) };
    const us = g.unitsOf[w.id] || [];
    // A task that holds its own PR's key and has no separate PR record is its own unit (W-149).
    const ownUnit = isPrUnit(w, bySource) || (!us.length && !!w.links?.pr && bySource[prKey(w.links.pr)] === w.id);
    if (ownUnit && merged(w.id)) out.push({ ...c, prs: [w.links.pr] });
    if (us.length && us.every(merged)) out.push({ ...c, prs: us.map(u => works[u].links.pr) });
  }
  return out;
}

/** Merge holds (W-292): `urls` to read, and with prState the {id, pr} holds whose PR merged. A bare #N is in the record's repo. */
export function holdReleases(works, owner, prState = () => null) {
  const url = (w, pr) => (pr.startsWith('#') ? `https://github.com/${owner}/${w.repo || 'built-rails'}/pull/${pr.slice(1)}` : pr);
  const holds = Object.values(works).filter(w => !TERMINAL.includes(w.phase)).flatMap(w => (w.externalDeps || []).filter(d => d.pr).map(d => ({ id: w.id, pr: d.pr, url: url(w, d.pr) })));
  return { urls: [...new Set(holds.map(h => h.url))], released: holds.filter(h => prState(h.url) === 'MERGED').map(({ id, pr }) => ({ id, pr })) };
}
