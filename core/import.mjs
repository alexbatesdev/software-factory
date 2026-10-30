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
  // Every other top-level key is its own row: V1 rewrites its notifier clock every tick, and that mustn't re-import the rest.
  for (const [key, val] of Object.entries(v1)) if (!COLLECTIONS.includes(key) && !same(state.legacy[key], val)) cmds.push({ kind: 'import', target: `legacy/${key}`, payload: val });
  for (const key of Object.keys(state.legacy)) if (!(key in v1)) cmds.push({ kind: 'import', target: `legacy/${key}`, payload: null });
  return cmds;
}

/** The V1 state.json this state was imported from, key for key. */
export function exportV1(state) {
  const out = { ...state.legacy };
  for (const c of COLLECTIONS) out[c] = state[c];
  return out;
}
