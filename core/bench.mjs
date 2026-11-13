// The review benchmark's fixed inputs (evolution phase 1 step 5), drawn from the board's history. Pure: the bench
// script pins each case's base from GitHub and writes the corpus file.
import { createHash } from 'node:crypto';
import { escapes } from './work.mjs';

const SHA = /\b[0-9a-f]{7,40}\b/;
// Feedback after a clean review counts as a miss only when a fix commit is named for it and it isn't marked nothing-to-do.
const confirmedFix = f => f.status === 'resolved' && SHA.test(f.note || '') && !/nothing to (fix|do)|not a (bug|defect)|already on main/i.test(f.note || '') ? f.note.match(SHA)[0] : null;

const base = (w, r) => ({ work: w.id, repo: w.links.pr.match(/github\.com\/([^/]+\/[^/]+)\/pull/)?.[1] || null, pr: w.links.pr, head: r.head,
  title: w.title, criteria: (w.criteria || []).map(c => `${c.id}: ${c.text}`), reviewedBy: r.by, reviewResult: r.result, reviewLink: r.link || null });

// One case per reviewed PR head: findings on it, from one record or several, become one expected list.
function merged(cases) {
  const by = new Map();
  for (const c of cases) {
    const k = `${c.pr}@${c.head}`, prev = by.get(k);
    if (!prev) { by.set(k, { ...c, expected: [...c.expected] }); continue; }
    for (const e of c.expected) if (!prev.expected.some(x => x.text === e.text && x.note === e.note)) prev.expected.push(e);
  }
  return [...by.values()];
}

/** {miss, defect, clean}: each a list of cases pinned to the head our review saw, newest first. */
export function corpusCandidates(state) {
  const out = { miss: [], defect: [], clean: [] };
  for (const w of Object.values(state.work)) {
    if (!w.links?.pr) continue;
    const ours = (w.reviews || []).filter(r => !r.forAlex && r.head);
    for (const e of escapes(w)) {
      const f = w.findings.find(x => x.id === e.finding), sha = confirmedFix(f), r = ours.find(x => x.head === e.reviewHead && x.result === 'clean');
      if (sha && r) out.miss.push({ ...base(w, r), at: r.at, expected: [{ text: f.text, note: f.note, source: f.source.type, confirmedBy: sha }] });
    }
    for (const r of ours.filter(r => r.result === 'findings')) {
      const fixed = w.findings.filter(f => f.reviewHead === r.head && f.status === 'resolved');
      if (fixed.length) out.defect.push({ ...base(w, r), at: r.at, expected: fixed.map(f => ({ text: f.text, severity: f.severity || null, source: 'internal review', confirmedBy: 'fixed in a later round' })) });
    }
    if (['done', 'merged'].includes(w.phase) && ours.length === 1 && ours[0].result === 'clean' && !escapes(w).length && !(w.findings || []).length)
      out.clean.push({ ...base(w, ours[0]), at: ours[0].at, expected: [] });
  }
  for (const k of Object.keys(out)) out[k] = merged(out[k]).sort((a, b) => b.at.localeCompare(a.at));
  return out;
}

const splitOf = id => createHash('sha256').update(id).digest()[0] < 179 ? 'eval' : 'tune';

/** The newest `n[kind]` of each kind, each with a stable id and its eval/tune split. */
export function selectCorpus(cands, n = { miss: 4, defect: 3, clean: 3 }) {
  return Object.entries(n).flatMap(([kind, k]) => (cands[kind] || []).slice(0, k).map(c => {
    const id = `B-${kind}-${c.work}-${c.head.slice(0, 7)}`;
    return { id, kind, split: splitOf(id), ...c };
  }));
}
