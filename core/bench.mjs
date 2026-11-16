// The review benchmark's fixed inputs (evolution phase 1 step 5), drawn from the board's history. Pure: the bench
// script pins each case's base from GitHub and writes the corpus file.
import { createHash } from 'node:crypto';
import { escapes } from './work.mjs';

const SHA = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
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
      if (fixed.length) out.defect.push({ ...base(w, r), at: r.at, expected: fixed.map(f => ({ text: f.text || f.note, note: f.note || null, severity: f.severity || null, source: 'internal review', confirmedBy: 'fixed in a later round' })) });
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

/** Observational quality since `since`, from the same run records: advisory, never a model score. */
export function qualityReport(state, since) {
  const ws = Object.values(state.work), arts = Object.values(state.artifacts || {});
  const reviews = ws.flatMap(w => (w.reviews || []).filter(r => !r.forAlex && r.at >= since).map(r => ({ w, r })));
  const started = ws.flatMap(w => (w.assignments || []).flatMap(a => (a.history || []).filter(h => h.status === 'started' && h.at >= since).map(() => `${w.id}/${a.id}`)));
  return {
    since,
    reviews: { total: reviews.length, clean: reviews.filter(x => x.r.result === 'clean').length, findings: reviews.filter(x => x.r.result === 'findings').length,
      evidenceRetained: reviews.filter(x => arts.some(a => a.work === x.w.id && a.head === x.r.head && a.status === 'retained')).length },
    runs: { started: started.length, withManifest: started.filter(k => Object.keys(state.manifests || {}).some(m => m.startsWith(`${k}/`))).length },
    escapesUnadjudicated: ws.flatMap(w => escapes(w).filter(e => e.at >= since)).length,
  };
}

/** The baseline's runs: eval cases with a pinned base, `repeats` times per reviewer, rounds interleaved so a cut-short night still covers every case. */
export function benchPlan(corpus, { repeats = 3, agents = ['claude', 'codex'] } = {}) {
  const cases = corpus.cases.filter(c => c.split === 'eval' && c.base);
  return agents.flatMap(agent => Array.from({ length: repeats }, (_, i) => i + 1).flatMap(n => cases.map(c => ({ case: c, agent, n, dir: `bench-${c.id}-${agent}-${n}` }))));
}

/** What the reviewer is told: the case's goal and pinned range, never its expected findings. */
export function reviewPrompt(c, agent, { goal = '' } = {}) {
  const head = [
    'Benchmark run (the software factory\'s review baseline). You are the reviewer only: no edits, no commits, no pushes, no fetches, and no GitHub reads or writes of any kind (no gh, no PR page, no comments).',
    `Judge only the change ${c.base}..${c.head} in this worktree. Don't read other branches, later commits or main's history.`,
    `Repo: ${c.repo}   PR: #${c.pr.split('/').pop()} (for reference only; don't open it)`,
    `Reviewed head: ${c.head}   Base: ${c.base} (pinned: use it wherever the review instructions say origin/main)`,
    `Goal: ${[c.title, goal].filter(Boolean).join('. ')}`,
    `Acceptance criteria (verbatim): ${c.criteria.length ? `\n${c.criteria.join('\n')}` : 'none recorded'}`,
  ].join('\n');
  return agent === 'codex'
    ? `${head}\n\nFollow /home/agent/standards/internal-review-codex.md (above) as the reviewer: sections 1 to 4 only. Its "After the review" steps are not yours.`
    : `${head}\n\nRun the internal-review skill's steps 1 to 3: pin the target, pick the effort and lenses, and spawn one fresh Opus reviewer subagent with its instruction. Stop when it returns: don't triage or fix. Your final message is the subagent's findings verbatim, starting \`reviewed <sha>: N findings\`.`;
}

const mins = ms => `${Math.round((ms || 0) / 60000)}m`;
/** A markdown sheet for scoring by hand: each case's expected findings, then every run's output with blanks. */
export function scoreSheet(corpus, runs) {
  const out = ['# Review benchmark baseline: score sheet', '',
    'Score each run by hand: how many expected findings it found, and how many extra findings it raised (say which are real). Never auto-scored.',
    'Caveat: a miss case\'s fix commit is in the checkout\'s history (main). The prompt forbids reading history but can\'t prevent it; note any run that cites a later commit.', ''];
  for (const c of corpus.cases.filter(x => runs.some(r => r.case === x.id))) {
    out.push(`## ${c.id} (${c.kind}, ${c.repo} #${c.pr.split('/').pop()}, head ${c.head.slice(0, 7)})`, '', 'Expected:');
    out.push(...(c.expected.length ? c.expected.map(e => `- ${e.text || '(no text)'}${e.note ? `\n  Fix note: ${e.note}` : ''}${e.confirmedBy ? ` (confirmed by ${e.confirmedBy})` : ''}`) : ['- none: a clean merge, so every finding is extra']), '');
    for (const r of runs.filter(x => x.case === c.id).sort((a, b) => a.agent.localeCompare(b.agent) || a.n - b.n))
      out.push(`### ${r.agent} #${r.n} · ${r.status} · ${mins(r.durationMs)}${r.usage ? ` · ${r.usage}` : ''}`, '', '~~~~', r.output || '(no output)', '~~~~', '',
        `Expected found: ___ / ${c.expected.length}   Extra findings: ___   Notes:`, '');
  }
  return out.join('\n');
}
