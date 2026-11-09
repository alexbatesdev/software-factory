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
 * A recorded wait, an open question or an excluded record stays open; merged ≠ every requirement met for those.
 * @param ctx {prState: url => 'OPEN'|'MERGED'|'CLOSED'|null, openQuestions: id => n, track: w => 'excluded'|...}
 */
export function mergeCloses(works, bySource, { prState, openQuestions, track }) {
  const g = groupIndex(works, bySource), out = [];
  // Alex's merge is his decision, so a wait or open question doesn't hold the record open (W-248); it is named in the close.
  const live = w => w && !TERMINAL.includes(w.phase) && track(w) !== 'excluded';
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

/** Merge holds (W-292): `urls` to read, and with prState the {id, pr} holds whose PR merged (`released`) or closed unmerged (`closed`). A bare #N is in the record's repo. */
export const prRefUrl = (w, pr, owner) => (pr.startsWith('#') ? `https://github.com/${owner}/${w.repo || 'built-rails'}/pull/${pr.slice(1)}` : pr);
export const PR_REF = /^(#\d+|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+)$/;

export function holdReleases(works, owner, prState = () => null) {
  const live = Object.values(works).filter(w => !TERMINAL.includes(w.phase));
  const holds = live.flatMap(w => (w.externalDeps || []).filter(d => d.pr).map(d => ({ id: w.id, pr: d.pr, url: prRefUrl(w, d.pr, owner) })));
  const parkedOn = live.flatMap(w => (w.assignments || []).filter(a => a.status === 'blocked' && PR_REF.test(a.waitingOn || '')).map(a => prRefUrl(w, a.waitingOn, owner)));
  return { urls: [...new Set([...holds.map(h => h.url), ...parkedOn])], released: holds.filter(h => prState(h.url) === 'MERGED').map(({ id, pr }) => ({ id, pr })),
    closed: holds.filter(h => prState(h.url) === 'CLOSED').map(({ id, pr }) => ({ id, pr })) };
}

/** Question holds (Alex, 11-09): the {id, question} holds whose question Alex answered (`released`) or that closed unanswered (`closed`). */
export function questionHolds(works, questions) {
  const holds = Object.values(works).filter(w => !TERMINAL.includes(w.phase)).flatMap(w => (w.externalDeps || []).filter(d => d.question).map(d => ({ id: w.id, question: d.question })));
  const status = h => questions[h.question]?.status;
  return { released: holds.filter(h => ['answered', 'settled'].includes(status(h))), closed: holds.filter(h => status(h) === 'superseded') };
}

/** Every PR whose state a live record's merge-close needs: its own and its units', even a finished unit's (W-51). */
export function watchedPrs(works, bySource) {
  const g = groupIndex(works, bySource);
  return [...new Set(Object.values(works).filter(w => !TERMINAL.includes(w.phase)).flatMap(w => [w.links?.pr, ...(g.unitsOf[w.id] || []).map(u => works[u].links?.pr)]).filter(Boolean))];
}

/** Review-dated holds whose date has passed (W-317): {id, by, reviewer}. The caller notifies; nothing here releases a hold. */
export function reviewsDue(works, now) {
  const today = String(now).slice(0, 10);
  return Object.values(works).filter(w => !TERMINAL.includes(w.phase)).flatMap(w => (w.externalDeps || []).filter(d => d.review && d.review.by < today).map(d => ({ id: w.id, by: d.review.by, reviewer: d.review.reviewer })));
}

const HOUR = 3600000, ago = (now, t) => Date.parse(now) - Date.parse(t || 0);
/** Contradictions the hourly audit routes to the board lead (W-317): {id, kind, evidence, next}. Detects only; mergeTick repairs merges. */
export function contradictions(state, { prState = () => null, now }) {
  const out = [], add = (id, kind, evidence, next) => out.some(c => c.id === id && c.kind === kind) || out.push({ id, kind, evidence, next });
  const resumedAt = Object.fromEntries(Object.values(state.messages || {}).filter(m => m.about?.resume).map(m => [m.about.resume, m.at]));
  for (const w of Object.values(state.work).filter(w => !TERMINAL.includes(w.phase))) {
    if (['awaiting_human_approval', 'ready_for_human'].includes(w.phase) && prState(w.links?.pr) === 'MERGED')
      add(w.id, 'merged-awaiting', `${w.links.pr} reads MERGED but the record is still ${w.phase}`, 'check why merge-close skipped it (coverage beyond the PR?) and close or re-scope it');
    for (const a of w.assignments || []) {
      const sent = resumedAt[`${w.id}/${a.id}/v${a.version}`];
      if (a.status === 'blocked' && sent && ago(now, sent) > 2 * HOUR)
        add(w.id, 'answered-still-blocked', `${a.id} was told to resume at ${sent} (${a.waitingOn} cleared) and is still blocked`, `ask its supervisor to brief it or re-block it on what it really waits on`);
      const last = [a.at, ...(w.updates || []).map(u => u.at)].sort().at(-1);
      if (a.status === 'started' && ago(now, last) > 6 * HOUR)
        add(w.id, 'started-silent', `${a.id} started with no note since ${last}`, 'check the worker pane; record progress, block it, or cancel it');
    }
    const fix = w.kind === 'factory' && !(w.externalDeps || []).length && !w.waitingOn && (w.updates || []).find(u => /\b[0-9a-f]{7,40}\b/.test(u.text || ''));
    if (fix && ago(now, w.updatedAt) > 24 * HOUR)
      add(w.id, 'factory-fix-open', `a note names a commit ("${fix.text.slice(0, 80)}") and nothing has moved since ${w.updatedAt}`, 'resolve it with that commit, or say what is left');
  }
  return out;
}
