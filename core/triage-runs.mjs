// Run triage: a user-launched triage agent in its own pane, with results returned as structured data.
// Pure functions; the server persists runs and owns the herdr launch.
import crypto from 'node:crypto';
import { TERMINAL, ACTIVE } from './work.mjs';

// A missing result can still arrive late, so needs-attention blocks too until Alex abandons or reconciles it.
const BLOCKING = ['starting', 'running', 'uncertain', 'needs-attention'];
const BUCKETS = ['ready', 'clarify', 'rewrite', 'human'];
const COVERAGE = ['unknown', 'partial', 'none'];
const str = (v, max, name) => {
  if (v == null) return null;
  if (typeof v !== 'string' || v.length > max) throw new Error(`${name} must be a string of at most ${max} characters.`);
  return v;
};

/** Claim a new run synchronously, so a double click or a reload can't start two. */
export function claimRun(runs, { scope, works, revisionOf, by, now, kind = 'triage' }) {
  const open = Object.values(runs).find(r => BLOCKING.includes(r.status));
  if (open) throw new Error(open.status === 'uncertain'
    ? `${open.id} has an uncertain launch; check its pane and resolve it before starting another.`
    : `${open.id} is already ${open.status}.`);
  if (!scope.length) throw new Error(kind === 'verify' ? 'No questions are waiting on verification.' : 'Nothing to triage.');
  const id = `TR-${Object.keys(runs).length + 1}`;
  const rev = revisionOf || (w => works[w]?.updatedAt || null);
  // A verify run's scope is questions; a triage run's is work records.
  runs[id] = { id, kind, status: 'starting', by, at: now, scope: scope.map(x => kind === 'verify' ? { question: x, revision: rev(x) } : { work: x, revision: rev(x) }), steps: [], pane: null, result: null };
  return runs[id];
}

/** A launch interrupted by a restart may or may not have created a pane: uncertain, never relaunched. */
export function reconcileRunsOnStart(runs, now) {
  for (const r of Object.values(runs || {})) if (r.status === 'starting') Object.assign(r, { status: 'uncertain', detail: 'Server restarted during launch; check for its pane.', reconciledAt: now });
  return runs;
}

/** Throws with a readable reason if the payload is outside the run's scope or the schema. */
export function validateResults(run, p) {
  if (!p || p.run !== run.id) throw new Error(`Results are for run ${p?.run}, not ${run.id}.`);
  const scope = new Set(run.scope.map(s => s.work));
  if (!Array.isArray(p.items)) throw new Error('items must be a list.');
  const seen = new Set();
  for (const it of p.items) {
    if (!scope.has(it.work)) throw new Error(`${it.work} is outside this run's scope.`);
    if (seen.has(it.work)) throw new Error(`${it.work} appears more than once; each item is assessed once.`);
    seen.add(it.work);
    if (it.revision !== run.scope.find(x => x.work === it.work).revision) throw new Error(`${it.work}: revision doesn't match the one this run was launched with.`);
    if (it.skipped) { if (!it.reason) throw new Error(`${it.work}: a skipped item needs a reason.`); str(it.reason, 600, 'reason'); continue; }
    if (!BUCKETS.includes(it.bucket)) throw new Error(`${it.work}: bucket must be one of ${BUCKETS.join(', ')}.`);
    if (!it.summary?.trim() || !it.evidence?.trim()) throw new Error(`${it.work}: a summary and the evidence consulted are required.`);
    str(it.summary, 600, `${it.work} summary`); str(it.evidence, 1000, `${it.work} evidence`);
    if (it.coverage && (!COVERAGE.includes(it.coverage.state) || (it.coverage.missing && str(it.coverage.missing, 600, 'coverage.missing') == null))) throw new Error(`${it.work}: coverage state must be ${COVERAGE.join(', ')}.`);
    const qs = it.questions || [];
    if (!Array.isArray(qs) || qs.length > 5) throw new Error(`${it.work}: at most 5 questions.`);
    for (const q of qs) {
      str(q.title, 300, 'question title'); str(q.recommendWhy, 600, 'recommendWhy'); str(q.promptedBy, 600, 'promptedBy');
      if (!q.title || !Array.isArray(q.options) || q.options.length < 2 || q.options.length > 5 || q.options.some(o => !o.key || !o.text || o.text.length > 300)) throw new Error(`${it.work}: each question needs 2–5 options with key and text.`);
    }
  }
  const missing = [...scope].filter(w => !seen.has(w));
  if (missing.length) throw new Error(`Every item in the run needs an assessment or an explicit skip with a reason; missing ${missing.join(', ')}.`);
  const ds = p.discoveries || [];
  if (!Array.isArray(ds) || ds.length > 5) throw new Error('At most 5 discoveries.');
  for (const d of ds) { if (!d.title) throw new Error('A discovery needs a title.'); str(d.title, 200, 'discovery title'); str(d.objective, 600, 'discovery objective'); }
  return p;
}

/** Which items can be applied now. Anything that changed, closed, started or got an owner since launch is stale. */
// `revisionOf` covers the record and its questions/answers/coverage, so an answer that lands mid-run makes it stale.
export function planApply(run, p, works, revisionOf = id => works[id]?.updatedAt) {
  const apply = [], stale = [], skipped = [];
  for (const it of p.items) {
    if (it.skipped) { skipped.push({ work: it.work, reason: it.reason }); continue; }
    const w = works[it.work];
    const was = run.scope.find(s => s.work === it.work)?.revision;
    const reason = !w ? `${it.work} no longer exists` : TERMINAL.includes(w.phase) ? `${it.work} is ${w.phase}` : ACTIVE.includes(w.phase) ? `${it.work} is ${w.phase}`
      : w.owner ? `${it.work} is assigned to ${w.owner}` : revisionOf(it.work) !== was ? `${it.work} changed since the run started (record, questions or coverage)` : null;
    (reason ? stale : apply).push({ ...it, reason });
  }
  return { apply, stale, skipped };
}

export const runDigest = p => crypto.createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 24);

const OUTCOMES = ['live', 'answered', 'cannot-verify'];
/** A verify run's results: every question in scope once, with live | answered | cannot-verify, evidence, and a reason when it can't be verified. */
export function validateVerify(run, p) {
  if (!p || p.run !== run.id) throw new Error(`Results are for run ${p?.run}, not ${run.id}.`);
  if (!Array.isArray(p.questions)) throw new Error('questions must be a list.');
  const scope = new Map(run.scope.map(s => [s.question, s.revision])), seen = new Set();
  for (const q of p.questions) {
    if (!scope.has(q.id)) throw new Error(`${q.id} is outside this run's scope.`);
    if (seen.has(q.id)) throw new Error(`${q.id} appears more than once.`);
    seen.add(q.id);
    if (q.revision !== scope.get(q.id)) throw new Error(`${q.id}: revision doesn't match the one this run was launched with.`);
    if (!OUTCOMES.includes(q.outcome)) throw new Error(`${q.id}: outcome must be one of ${OUTCOMES.join(', ')}.`);
    if (!q.evidence?.trim()) throw new Error(`${q.id}: the evidence consulted is required.`);
    str(q.evidence, 1000, `${q.id} evidence`);
    if (q.outcome === 'cannot-verify' && !q.reason?.trim()) throw new Error(`${q.id}: cannot-verify needs the reason an agent can't check it.`);
    str(q.reason, 600, `${q.id} reason`);
  }
  const missing = [...scope.keys()].filter(id => !seen.has(id));
  if (missing.length) throw new Error(`Every question in the run needs an outcome; missing ${missing.join(', ')}.`);
  return p;
}
/** Which outcomes can be applied now. A question no longer open, or changed since launch, is stale. */
export function planVerify(run, p, questions, revisionOf) {
  const apply = [], stale = [];
  for (const q of p.questions) {
    const cur = questions[q.id];
    const reason = !cur ? `${q.id} no longer exists` : cur.status !== 'open' ? `${q.id} is ${cur.status}` : revisionOf(q.id) !== run.scope.find(s => s.question === q.id).revision ? `${q.id} changed since the run started` : null;
    (reason ? stale : apply).push({ ...q, reason: reason || q.reason });
  }
  return { apply, stale };
}
