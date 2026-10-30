// V1 state.json enters the log whole: one `import` row per record that is new or changed since the last import.
export const COLLECTIONS = ['work', 'questions', 'notifications'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Commands that bring `state` level with the V1 snapshot `v1`. Empty when nothing changed. */
export function importCommands(v1, state) {
  const cmds = [];
  for (const c of COLLECTIONS) {
    for (const [key, rec] of Object.entries(v1[c] || {})) if (!same(state[c][key], rec)) cmds.push({ kind: 'import', target: `${c}/${key}`, payload: rec });
    for (const key of Object.keys(state[c])) if (!(key in (v1[c] || {}))) cmds.push({ kind: 'import', target: `${c}/${key}`, payload: null });
  }
  const legacy = Object.fromEntries(Object.entries(v1).filter(([k]) => !COLLECTIONS.includes(k)));
  if (!same(state.legacy, legacy)) cmds.push({ kind: 'import', target: 'legacy', payload: legacy });
  return cmds;
}

/** The V1 state.json this state was imported from, key for key. */
export function exportV1(state) {
  const out = { ...state.legacy };
  for (const c of COLLECTIONS) out[c] = state[c];
  return out;
}
