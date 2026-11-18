// Tokens and cost per job (W-561): read from the agent's own session logs over the job's active stretches, kept as a
// `usage:W-n/R-n` manifest entry (the manifest fold keeps any key), and priced from config.prices. Pure apart from the reader.

/** A job's stretches as started: each history entry is the status being left, at the change. */
export function activeWindows(a) {
  const h = a.history || [], out = [];
  for (let i = 1; i < h.length; i++) if (h[i].status === 'started') out.push([h[i - 1].at, h[i].at]);
  return out;
}

/** Dollars for {model: tokens}, or null when a model has no price: unknown is never shown as free. */
export function costOf(byModel, prices = {}) {
  let total = 0;
  for (const [model, t] of Object.entries(byModel || {})) {
    const p = prices[model];
    if (!p) return null;
    total += ['input', 'output', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead'].reduce((s, k) => s + (t[k] || 0) * (p[k] || 0), 0) / 1e6;
  }
  return Math.round(total * 100) / 100;
}

/** Finished worker jobs whose usage isn't recorded yet. @param workers sbx worker labels @param since record from */
export function usageDue(state, { workers, since }) {
  const out = [];
  for (const w of Object.values(state.work))
    for (const a of w.assignments || []) {
      const key = `usage:${w.id}/${a.id}`, windows = activeWindows(a);
      if (a.status === 'done' && workers.includes(a.owner) && windows.length && windows[0][0] >= since && !state.manifests?.[key]) out.push({ w, a, key, windows });
    }
  return out;
}

export const sumTokens = byModel => Object.values(byModel || {}).reduce((n, t) => n + (t.input || 0) + (t.output || 0) + (t.cacheWrite5m || 0) + (t.cacheWrite1h || 0) + (t.cacheRead || 0), 0);
