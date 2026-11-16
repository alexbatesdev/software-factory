// Re-requesting a reviewer (Alex, 11-11, W-426): once a non-approving human reviewer's threads on our PR are all
// resolved and the head has moved past their review, the board re-requests them, once per round. Approvers and bots
// are left alone. Pure: the server reads GitHub, makes the request, and records it.
import { TERMINAL } from './work.mjs';

/**
 * @param opts {now, maxAgeMs}: a round older than maxAgeMs is left alone (Alex, 11-11: recent reviews only)
 * @param works state.work @param prs [{url, author, head, isDraft, reviews: [{by, state, at, commit, bot, body}], threads: [{by, resolved, lastBy}], comments: [{by, at}], requested: [login]}]
 * @returns [{work, pr, reviewer, head, reviewAt, state}]
 */
export function rerequestPlan(works, prs, { now = Date.now(), maxAgeMs = Infinity } = {}) {
  const out = [];
  for (const p of prs) {
    const w = Object.values(works).find(x => x.links?.pr === p.url && !TERMINAL.includes(x.phase));
    if (!w || p.isDraft) continue;
    const latest = new Map();
    for (const r of [...p.reviews].sort((a, b) => a.at.localeCompare(b.at))) if (!r.bot) latest.set(r.by, r);
    for (const [by, r] of latest) {
      if (now - Date.parse(r.at) > maxAgeMs) continue;
      if (by === p.author || r.state === 'APPROVED' || r.commit === p.head || (p.requested || []).includes(by)) continue;
      // Everything they said needs an answer from the author first (W-521): a thread still open or whose last word is
      // theirs, a review body with no author comment after it, or a PR comment of theirs after the author's last one.
      if ((p.threads || []).some(t => t.by === by && (!t.resolved || (t.lastBy && t.lastBy !== p.author)))) continue;
      const mine = (p.comments || []).filter(c => c.by === p.author).map(c => c.at).sort().at(-1) || '';
      if (String(r.body || '').trim() && !(mine > r.at)) continue;
      if ((p.comments || []).some(c => c.by === by && c.at > mine)) continue;
      if ((w.rerequests || []).some(x => x.reviewer === by && x.reviewAt === r.at)) continue;
      out.push({ work: w.id, pr: p.url, reviewer: by, head: p.head, reviewAt: r.at, state: r.state });
    }
  }
  return out;
}
