// GitHub auto-merge for our PRs (W-564, Alex 11-18: "For any PR we open that isn't tied to a project or other merge-hold,
// we should turn on auto-merge"). GitHub's own gate is one approval and one check, so the factory holds it to Alex's bar:
// 2 human approvals on the current head, one from the QA team and one from another developer, and nothing left open.
import { sameSha } from './work.mjs';

/** Why this record's PR may not auto-merge, or null when it may. */
function blocker(w, p, { me, qa, devs, spec }) {
  if (p.state !== 'OPEN') return 'not open';
  if (p.author !== me) return 'not ours';
  if (p.isDraft) return 'still a draft';
  if (p.base !== 'main') return `its base is ${p.base}, not main (stacked or release-bound)`;
  if (w.phase !== 'awaiting_human_approval') return `the record is ${w.phase}, not awaiting approval`;
  if (!sameSha(w.head, p.head)) return 'the record and GitHub disagree on the head';
  const s = spec(w);
  if (s.status !== 'no spec') return s.slug ? `tied to project ${s.slug}` : `its project is ${s.status}`;
  if (w.waitingOn || (w.externalDeps || []).length) return 'a hold is on the record';
  if ((w.findings || []).some(f => f.status === 'open')) return 'an open finding';
  if (p.reviewDecision === 'CHANGES_REQUESTED') return 'changes requested';
  if (p.unresolvedThreads) return `${p.unresolvedThreads} unresolved review thread(s)`;
  const onHead = (p.approvals || []).filter(a => sameSha(a.commit, p.head)).map(a => a.by);
  const q = onHead.find(by => qa.includes(by));
  if (!q) return 'no QA approval on the current head';
  if (!onHead.some(by => by !== q && by !== me && devs.includes(by))) return 'no dev approval on the current head';
  return null;
}

/**
 * @param prs Map(url → {state, isDraft, base, head, author, reviewDecision, unresolvedThreads, autoMerge, approvals: [{by, commit}]})
 * @param cfg {me, qa: [logins], devs: [logins], spec(w) → resolveSpec result}
 * @returns [{work, pr, action: 'enable' | 'disable' | null, reason}] one per record with a read PR, except one already right
 */
export function autoMergePlan(records, prs, cfg) {
  const out = [];
  for (const w of records) {
    const p = prs.get(w.links?.pr);
    if (!p) continue;
    const why = blocker(w, p, cfg);
    if (!why && !p.autoMerge) out.push({ work: w.id, pr: p.url, action: 'enable', reason: 'QA and dev approvals on the head, no project or hold, nothing open' });
    else if (why && p.autoMerge) out.push({ work: w.id, pr: p.url, action: 'disable', reason: why });
    else if (why) out.push({ work: w.id, pr: p.url, action: null, reason: why });
  }
  return out;
}
