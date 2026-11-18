// The deliverable inbox (Alex 11-18): a task's report or information that doesn't belong in a git repo. Agents deliver it
// to its record; Alex and agents read it and archive it once it no longer matters. Delivering never closes the record.
const fail = msg => { throw new Error(msg); };
export const DELIVERABLE_KINDS = ['deliverable', 'deliverable_archive'];
export const MAX_TEXT = 200000;

/** Apply one deliverable row to state.deliverables in place; returns the D id. */
export function foldDeliverable(state, { kind, target, payload: p, ctx }) {
  state.deliverables ??= {}; state.nextDeliverable ??= 1;
  if (kind === 'deliverable') {
    if (!state.work[p.work]) fail(`There is no work item ${p.work}.`);
    if (!String(p.title || '').trim()) fail('A deliverable needs a title.');
    if (!String(p.text || '').trim()) fail('A deliverable needs its text (markdown).');
    if (String(p.text).length > MAX_TEXT) fail(`A deliverable's text is at most ${MAX_TEXT} characters; split it or summarise.`);
    const id = `D-${state.nextDeliverable++}`;
    state.deliverables[id] = { id, work: p.work, title: String(p.title).trim().slice(0, 200), text: String(p.text), from: ctx.by, at: ctx.now, archived: null };
    return id;
  }
  const d = state.deliverables[target] || fail(`There is no deliverable ${target}.`);
  state.deliverables[target] = { ...d, archived: p.unarchive ? null : { by: ctx.by, at: ctx.now, note: p.note ? String(p.note).slice(0, 500) : null } };
  return target;
}
