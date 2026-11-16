// "Red on main" by failing tests, not check names (W-501, Alex 11-16). Pure: sources/circleci.mjs reads the runs.

/**
 * @param pr, main {status, tests: [failing test ids] | null} the job's latest run at the PR head and on main; tests null
 *   (or empty on a failed job) means it failed before any test ran
 * @returns {verdict: 'red on main' | 'ours' | 'no test results' | 'unknown', prOnly, shared}
 */
export function compareCheck(pr, main) {
  if (!pr) return { verdict: 'unknown', prOnly: [], shared: [] };
  if (!pr.tests?.length) return { verdict: 'no test results', prOnly: [], shared: [] };
  if (!main) return { verdict: 'ours', prOnly: [...pr.tests], shared: [] };
  if (!main.tests) return { verdict: 'unknown', prOnly: [], shared: [] };
  const onMain = new Set(main.tests), prOnly = pr.tests.filter(t => !onMain.has(t)), shared = pr.tests.filter(t => onMain.has(t));
  return { verdict: prOnly.length ? 'ours' : 'red on main', prOnly, shared };
}

const list = ts => `${ts.slice(0, 5).join(', ')}${ts.length > 5 ? `, and ${ts.length - 5} more` : ''}`;
/** One line for the record. */
export function compareText(check, c) {
  if (c.verdict === 'no test results') return `${check}: failed before any test ran: rerun it, it says nothing about this PR's code.`;
  if (c.verdict === 'red on main') return `${check}: all ${c.shared.length} failing test(s) also fail on main.`;
  if (c.verdict === 'ours') return `${check}: ${c.prOnly.length} test(s) fail here and not on main (${list(c.prOnly)})${c.shared.length ? `; ${c.shared.length} also fail on main` : ''}.`;
  return `${check}: not compared (no run of it to compare).`;
}
