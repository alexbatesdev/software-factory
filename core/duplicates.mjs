// W-471: a New-PR record's duplicate search is re-run against open PRs until it is dispatched, not only at triage.
// Another author's PR opened since the search on a file the record names takes the approval back to Alex.
import { LIVE_ASSIGNMENT, DEFAULT_REPO } from './work.mjs';

export const repoOf = w => w.repo || DEFAULT_REPO;
const PATH = /(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z]\w*/g;

/** The repo files a record names in its objective and New-PR breakdown. */
export function pathsOf(w) {
  const text = [w.objective, ...Object.values(w.proposal || {})].filter(v => typeof v === 'string').join(' ').replace(/https?:\/\/\S+/g, '');
  return [...new Set(text.match(PATH) || [])];
}

/** New-PR records not yet built: a breakdown, no PR, nothing running. */
export const unbuiltProposals = state => Object.values(state.work).filter(w => w.proposal && !w.links?.pr && ['build', 'pr-feedback'].includes(w.kind)
  && ['intake', 'clarification', 'ready', 'queued'].includes(w.phase) && !(w.assignments || []).some(a => LIVE_ASSIGNMENT.includes(a.status)));

/**
 * @param prsByRepo {repo: [{url, author, createdAt, files}]} open PRs, read for the repos of unbuiltProposals
 * @returns duplicate_check events: new matches, or a clean check an approval since the last one is waiting on
 */
export function duplicateCommands(state, prsByRepo, { me }) {
  const out = [];
  for (const w of unbuiltProposals(state)) {
    const paths = pathsOf(w), seen = w.duplicateHits?.seen || [];
    const matches = (prsByRepo[repoOf(w)] || []).filter(p => p.author !== me && p.createdAt > w.proposal.at && !seen.includes(p.url))
      .map(p => ({ pr: p.url, author: p.author, createdAt: p.createdAt, files: p.files.filter(f => paths.includes(f)) })).filter(m => m.files.length);
    const due = w.prApproval && !(w.duplicateCheckedAt >= w.prApproval.at);
    if (matches.length || due) out.push({ kind: 'event', target: w.id, payload: { type: 'duplicate_check', matches, paths } });
  }
  return out;
}
