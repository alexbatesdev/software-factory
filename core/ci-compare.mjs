// "Red on main" by failing tests, not check names (W-501, Alex 11-16). Pure: sources/circleci.mjs reads the runs.

/**
 * @param pr, main {status, tests: [failing test ids] | null} the job's latest run at the PR head and on main; tests null
 *   (or empty on a failed job) means it failed before any test ran
 * @returns {verdict: 'red on main' | 'ours' | 'no test results' | 'unknown', prOnly, shared}
 */
export function compareCheck(pr, main) {
  if (!pr) return { verdict: 'unknown', prOnly: [], shared: [] };
  // A job failing without test results on main too (a fan-in job) says nothing test by test: the name match decides.
  if (!pr.tests?.length) return { verdict: main?.status === 'failed' && !main.tests?.length ? 'unknown' : 'no test results', prOnly: [], shared: [] };
  if (!main) return { verdict: 'ours', prOnly: [...pr.tests], shared: [] };
  if (!main.tests) return { verdict: 'unknown', prOnly: [], shared: [] };
  const onMain = new Set(main.tests), prOnly = pr.tests.filter(t => !onMain.has(t)), shared = pr.tests.filter(t => onMain.has(t));
  return { verdict: prOnly.length ? 'ours' : 'red on main', prOnly, shared };
}

const list = ts => `${ts.slice(0, 5).join(', ')}${ts.length > 5 ? `, and ${ts.length - 5} more` : ''}`;
/** One line for the record. */
export function compareText(check, c) {
  if (c.verdict === 'no test results') return `${check}: failed before any test ran: rerun it, it says nothing about this PR's code.`;
  if (c.verdict === 'fixed on main') return `${check}: ${c.prOnly.length} ${c.unit || 'failure'}(s) here are fixed on main since this branch's base (${list(c.prOnly)}): merge origin/main into the branch (merge, never rebase or force push) and push; no code fix needed.`;
  if (c.unit) {
    if (c.verdict === 'red on main') return `${check}: all ${c.shared.length} ${c.unit}(s) are also on main.`;
    if (c.verdict === 'ours') return `${check}: ${c.prOnly.length} ${c.unit}(s) here and not on main (${list(c.prOnly)})${c.shared.length ? `; ${c.shared.length} also on main` : ''}.`;
  }
  if (c.verdict === 'red on main') return `${check}: all ${c.shared.length} failing test(s) also fail on main.`;
  if (c.verdict === 'ours') return `${check}: ${c.prOnly.length} test(s) fail here and not on main (${list(c.prOnly)})${c.shared.length ? `; ${c.shared.length} also fail on main` : ''}.`;
  return `${check}: not compared (no run of it to compare).`;
}

/**
 * The Audit check by Brakeman warning (Alex 11-16: run Brakeman ourselves, on demand): main's when every warning on the PR
 * (by fingerprint) is also on main; the PR's when any isn't. No warnings on the PR: the red check is something else.
 */
export function compareWarnings(pr, main, base = null) {
  const label = w => `${w.type} ${w.file}:${w.line}`, onMain = new Set(main.map(w => w.fingerprint));
  if (!pr.length) return { verdict: 'unknown', prOnly: [], shared: [], unit: 'Brakeman warning' };
  const prOnly = pr.filter(w => !onMain.has(w.fingerprint)).map(label), shared = pr.filter(w => onMain.has(w.fingerprint)).map(label);
  // Gone from main but present where the branch started (W-520): main fixed them since; merging main clears them.
  const atBase = base && new Set(base.map(w => w.fingerprint)), stale = atBase && prOnly.length && pr.filter(w => !onMain.has(w.fingerprint)).every(w => atBase.has(w.fingerprint));
  return { verdict: stale ? 'fixed on main' : prOnly.length ? 'ours' : 'red on main', prOnly, shared, unit: 'Brakeman warning' };
}
