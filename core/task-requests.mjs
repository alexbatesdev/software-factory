// New Teamwork tasks Alex approves from the dashboard (11-10, W-382): a seat proposes one with everything create_task
// needs, Alex clicks, and the factory creates it through teamwork-mini itself. No agent creates a Teamwork task.
const fail = msg => { throw new Error(msg); };
export const TASK_KINDS = ['task_request', 'task_decide', 'task_op'];
export const STUCK_MS = 120000;
const posInt = v => v == null || (Number.isInteger(v) && v > 0);

/** Apply one task-request row to state.taskRequests in place; returns the NT id. */
export function foldTaskRequest(state, { kind, target, payload: p, ctx }) {
  state.taskRequests ??= {}; state.nextTaskRequest ??= 1;
  if (kind === 'task_request') {
    for (const k of ['work', 'name', 'why']) if (!String(p[k] ?? '').trim()) fail(`A task proposal needs "${k}".`);
    if (!p.tasklistId === !p.parentTaskId) fail('A task proposal names exactly one of tasklistId (a new task) or parentTaskId (a subtask).');
    for (const k of ['tasklistId', 'parentTaskId', 'assigneeUserId']) if (!posInt(p[k])) fail(`${k} is a Teamwork id (a positive integer).`);
    if (!state.work[p.work]) fail(`There is no work item ${p.work}.`);
    const dup = Object.values(state.taskRequests).find(t => t.work === p.work && t.name === p.name && !['declined', 'failed'].includes(t.status));
    if (dup) fail(`${p.work} already proposes "${p.name}" as ${dup.id}.`);
    const id = `NT-${state.nextTaskRequest++}`;
    state.taskRequests[id] = { id, work: p.work, name: String(p.name).slice(0, 250), description: p.description ? String(p.description).slice(0, 4000) : null,
      tasklistId: p.tasklistId || null, parentTaskId: p.parentTaskId || null, assigneeUserId: p.assigneeUserId || null, why: String(p.why).slice(0, 1000),
      status: 'requested', from: ctx.by, at: ctx.now, approvedBy: null, approvedAt: null, taskId: null, url: null, verified: null, detail: null };
    return id;
  }
  const t = state.taskRequests[target] || fail(`There is no task proposal ${target}.`);
  if (kind === 'task_decide') {
    // An approval with no outcome after STUCK_MS means the server stopped mid-create; it may be retried (after a check).
    const stuck = t.status === 'approved' && Date.parse(ctx.now) - Date.parse(t.approvedAt) > STUCK_MS;
    if (!['requested', 'failed'].includes(t.status) && !stuck) fail(`${target} is ${t.status}.`);
    state.taskRequests[target] = p.decision === 'approve' ? { ...t, status: 'approved', approvedBy: ctx.by, approvedAt: ctx.now, detail: null }
      : p.decision === 'decline' ? { ...t, status: 'declined', detail: p.note || null, approvedBy: ctx.by, approvedAt: ctx.now } : fail('A decision is approve or decline.');
  } else {
    if (t.status !== 'approved') fail(`${target} isn't approved.`);
    if (p.status === 'created' && !(p.taskId && p.url)) fail('A created task needs its id and url.');
    if (!['created', 'failed'].includes(p.status)) fail('A task outcome is created or failed.');
    state.taskRequests[target] = { ...t, status: p.status, taskId: p.taskId || null, url: p.url || null, verified: p.verified ?? null, detail: p.detail || null, doneAt: ctx.now };
  }
  return target;
}

/** Alex's decisions: approve creates each task through `tw` (teamwork-mini's client), reads it back and notes it on the record. */
export async function decideTaskRequests(store, ids, decision, note, tw, now) {
  const by = { now: now(), by: 'Alex (dashboard)' }, out = [];
  for (const id of [...new Set(ids)]) {
    try {
      // A retry (after a failure, or a create the server never finished) may follow an attempt Teamwork did commit.
      const retry = ['failed', 'approved'].includes(store.state.taskRequests[id]?.status);
      store.append({ kind: 'task_decide', target: id, payload: { decision, note } }, by);
      if (decision !== 'approve') { out.push({ id, ok: true }); continue; }
      const t = store.state.taskRequests[id];
      const where = t.tasklistId ? { tasklistId: t.tasklistId } : { parentTaskId: t.parentTaskId };
      const input = { ...where, name: t.name, ...(t.description ? { description: t.description } : {}), ...(t.assigneeUserId ? { assigneeUserId: t.assigneeUserId } : {}) };
      let made;
      try {
        if (!tw?.createTask) throw new Error('this factory has no Teamwork client');
        if (retry) {
          let found;
          try { found = await tw.findTask({ ...where, name: t.name }); } catch (e) { throw new Error(`couldn't check Teamwork for a task an earlier attempt made (${e.message}), so it wasn't retried`); }
          if (found) {
            store.append({ kind: 'task_op', target: id, payload: { status: 'created', taskId: found.id, url: found.url, verified: true, detail: 'An earlier attempt had created it; not created again.' } }, by);
            store.append({ kind: 'event', target: t.work, payload: { type: 'note', text: `Teamwork task ${found.url} from ${id}: an earlier attempt had created it (Alex approved on the dashboard).` } }, by);
            out.push({ id, ok: true, taskId: found.id, url: found.url, existing: true }); continue;
          }
        }
        made = await tw.createTask(input);
      } catch (e) {
        store.append({ kind: 'task_op', target: id, payload: { status: 'failed', detail: `${e.message}. Check Teamwork before retrying.` } }, by);
        out.push({ id, error: e.message }); continue;
      }
      const back = await tw.getTask?.(made.id).catch(() => null);
      const verified = !!back && back.name === t.name;
      store.append({ kind: 'task_op', target: id, payload: { status: 'created', taskId: made.id, url: made.url, verified } }, by);
      store.append({ kind: 'event', target: t.work, payload: { type: 'note', text: `Teamwork task ${made.url} created from ${id}, approved by Alex on the dashboard${verified ? '' : ' (read-back did not confirm it; check Teamwork)'}.` } }, by);
      out.push({ id, ok: true, taskId: made.id, url: made.url, verified });
    } catch (e) { out.push({ id, error: e.message }); }
  }
  return out;
}
