// GitHub auto-merge for small, quick fixes (W-564, Alex 11-18: "For any PR we open that isn't tied to a project or other
// merge-hold, we should turn on auto-merge. This will let quick security fixes get merged in much faster"; "meant for
// small and quick fixes, the kinds of things we are less picky about 2 approvals for"). The factory only switches it on;
// GitHub's own ruleset decides when it merges. Enabling auto-merge is not a merge. Work tied to a project or a hold keeps
// Alex's usual two-approval merge.
import { sameSha } from './work.mjs';

/** Why this record's PR doesn't get auto-merge, or null when it does. */
function blocker(w, p, { me, spec }) {
  if (p.state !== 'OPEN') return 'not open';
  if (p.author !== me) return 'not ours';
  if (p.isDraft) return 'still a draft';
  if (p.base !== 'main') return `its base is ${p.base}, not main (stacked or release-bound)`;
  if (w.phase !== 'awaiting_human_approval') return `the record is ${w.phase}, not awaiting approval after its internal review`;
  if (!sameSha(w.head, p.head)) return 'the record and GitHub disagree on the head';
  const s = spec(w);
  if (s.status !== 'no spec') return s.slug ? `tied to project ${s.slug}` : `its project is ${s.status}`;
  if (w.waitingOn || (w.externalDeps || []).length) return 'a hold is on the record';
  if (p.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  return null;
}

/**
 * @param prs Map(url → {state, isDraft, base, head, author, reviewDecision, autoMerge})
 * @param cfg {me, spec(w) → resolveSpec result}
 * @returns [{work, pr, action: 'enable' | 'disable' | null, reason}] one per record with a read PR, except one already right
 */
export function autoMergePlan(records, prs, cfg) {
  const out = [];
  for (const w of records) {
    const p = prs.get(w.links?.pr);
    if (!p) continue;
    // Its last word on this PR was "on" and it's off now: someone turned it off on GitHub, and that choice stands (#8569).
    const last = [...(w.updates || [])].reverse().find(u => u.by === 'factory (auto-merge)' && u.text.includes(` ${p.url}`));
    if (!p.autoMerge && last && / turned on for /.test(last.text)) { out.push({ work: w.id, pr: p.url, action: null, reason: 'auto-merge was turned off by someone after the factory turned it on: it stays off' }); continue; }
    const why = blocker(w, p, cfg);
    // GitHub takes no auto-merge on a PR already mergeable; merging it is Alex's, never the factory's (#8906).
    if (!why && !p.autoMerge && p.mergeState === 'CLEAN') out.push({ work: w.id, pr: p.url, action: null, reason: 'already mergeable, so GitHub takes no auto-merge on it: merging it is Alex\'s' });
    else if (!why && !p.autoMerge) out.push({ work: w.id, pr: p.url, action: 'enable', reason: 'a small, quick fix (main, no project, no hold, ready after its internal review); GitHub merges it once its own rules pass' });
    else if (why && p.autoMerge) out.push({ work: w.id, pr: p.url, action: 'disable', reason: why });
    else if (why) out.push({ work: w.id, pr: p.url, action: null, reason: why });
  }
  return out;
}
