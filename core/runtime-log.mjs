// The server's runtime log as JSON lines (evolution phase 1 step 4): each line carries the records and seats it
// names, tick errors say whether the surroundings or the factory failed, and tick timings are summarised per flush.
import { appendFileSync } from 'node:fs';

const ids = (text, re) => [...new Set(String(text).match(re) || [])];

/** The W-n, R-n and seat labels a line names; empty keys are left out. */
export function correlate(text) {
  const out = { work: ids(text, /\bW-\d+\b/g), assignment: ids(text, /\bR-?\d+\b/g), seat: ids(text, /\b(?:sup|sbx): [\w-]+/g) };
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v.length));
}

// A failed command, network or host tool is the environment; anything else thrown is the factory's own code.
const ENV = /ETIMEDOUT|ECONN|ENOTFOUND|EAI_AGAIN|socket hang up|rate limit|timed out|Command failed|\b(?:gh|sbx|herdr|git|sqlite3)\b.*(?:exit|failed)|HTTP \d{3}/i;
export const classify = e => (e?.cmd || ENV.test(String(e?.message))) ? 'environment' : 'controller';

export function createRuntimeLog(path, { now = () => new Date().toISOString(), warn = m => console.error(m) } = {}) {
  let failed = 0, sums = {};
  const write = o => {
    try { appendFileSync(path, `${JSON.stringify({ at: now(), ...o })}\n`); }
    catch (e) { if (!failed++) warn(`runtime log ${path} is not writable (${e.message}); the factory keeps running`); }
  };
  return {
    line: text => write({ type: 'line', text: String(text), ...correlate(text) }),
    tick(name, ms, err) {
      const s = sums[name] ??= { runs: 0, errors: 0, maxMs: 0, totalMs: 0 };
      s.runs++; s.totalMs += ms; s.maxMs = Math.max(s.maxMs, ms);
      if (err) { s.errors++; write({ type: 'tick', tick: name, outcome: 'error', ms, error: { kind: classify(err), message: String(err.message).slice(0, 500), at: String(err.stack || '').split('\n')[1]?.trim() || null }, ...correlate(err.message) }); }
    },
    flush() { for (const [tick, s] of Object.entries(sums)) write({ type: 'summary', tick, ...s }); sums = {}; },
    failures: () => failed,
  };
}
