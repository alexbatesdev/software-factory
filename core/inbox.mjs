// What each seat should find in its inbox: board requests, worker stops, idle queues and answers, as message commands.
// Pure. A message is created once per subject; waking the seat is the Wake port's job, not this one's.
import { eligibleRequests, planWorkerStops, planIdleQueues, planIdleOwners, routeOf, workerJob, PREFIX } from './notifier.mjs';

/**
 * Subjects already told: V2 messages, and imported V1 notifications (so cutover tells nobody twice).
 * @param v1Before only V1 notices sent before this time count; shadow mode passes its start so it decides independently.
 */
export function toldKeys(state, v1Before = null) {
  const told = new Set();
  for (const m of Object.values(state.messages)) for (const [k, v] of Object.entries(m.about || {})) for (const x of [v].flat()) told.add(`${k}:${x}`);
  for (const n of Object.values(state.notifications)) {
    if (n.status !== 'submitted' || v1Before && n.at >= v1Before) continue;
    for (const r of n.requests || []) told.add(`requests:${r}`);
    for (const a of n.answers || []) told.add(`answers:${a}`);
    if (n.workerStop) told.add(`workerStop:${n.workerStop}`);
    if (n.idleQueue) told.add(`idleQueue:${n.idleQueue}`);
  }
  return told;
}

const msg = (to, work, about, text) => ({ kind: 'message', payload: { to, work, about, text: `${PREFIX} ${text}` } });
const quote = t => `"${String(t).replace(/["\n]/g, "'").slice(0, 60)}"`;

/**
 * @param cfg {supervisors, seats: labels that exist, router, cutoff, answersSince, v1Before}
 * @param fleet {units, now, watches: {workerStops, idleQueues}} or null when the fleet couldn't be read
 * @returns {{cmds, watches}}
 */
export function inboxCommands(state, cfg, fleet = null) {
  const told = toldKeys(state, cfg.v1Before), cmds = [];
  for (const e of eligibleRequests(state.work, cfg.cutoff, cfg.supervisors)) {
    if (!e.to || told.has(`requests:${e.key}`)) continue;
    cmds.push(msg(e.to, e.work, { requests: e.key }, `${e.key} ${e.type}${e.synthetic ? ' [SYNTHETIC]' : ''} ${quote(e.title)}: read the record and handle it per your role; ack the request when you have.`));
  }
  for (const [id, q] of Object.entries(state.questions)) {
    if (q.status !== 'answered' || !q.answer || told.has(`answers:${id}`) || q.answer.sentTo || (cfg.answersSince && q.answer.at < cfg.answersSince)) continue;
    const rec = state.work[q.work];
    // The router's pick wins; else the asking seat if it still exists, else the record's stream, else the router.
    const to = q.answer.routeTo || [q.from].find(f => cfg.seats.includes(f)) || (rec && routeOf(rec, cfg.supervisors)) || cfg.router;
    cmds.push(msg(to, q.work || null, { answers: id }, `Answer to ${id}${q.from && q.from !== to ? ` (asked by ${q.from})` : ''}: ${[q.answer.choice && `(${q.answer.choice})`, q.answer.note].filter(Boolean).join(' ')}`));
  }
  let watches = fleet?.watches || {};
  if (fleet) {
    const stops = planWorkerStops({ units: fleet.units, works: state.work, watch: watches.workerStops, now: fleet.now, supervisors: cfg.supervisors });
    // The watch fires once per stop; a told-key check here would swallow a second stop on the same assignment.
    for (const d of stops.due)
      cmds.push(msg(d.to, d.work, { workerStop: `${d.work}/${d.assignment}` }, `${d.worker} stopped while ${d.work} ${d.assignment} is started: read its pane and record what it reported.`));
    const sent = Object.fromEntries([...told].filter(k => k.startsWith('idleQueue:')).map(k => [k.slice(10), true]));
    const drain = fleet.drain || new Map();
    // A draining stream takes no new work: its supervisor hears once per sandbox, and gets no "your stream is free" wake.
    for (const u of fleet.units) {
      const why = drain.get(u.supervisor?.label), key = `${u.worker?.label}/${u.worker?.sandbox || u.worker?.ref}`;
      if (why && u.worker && !told.has(`recycle:${key}`)) cmds.push(msg(u.supervisor.label, null, { recycle: key }, `${why}. Finish the running job, then start nothing new: the factory recycles the worker between tasks and tells you when the fresh one is up.`));
    }
    const idle = planIdleQueues({ units: fleet.units.filter(u => !drain.has(u.supervisor?.label)), works: state.work, watch: watches.idleQueues, sent, now: fleet.now, supervisors: cfg.supervisors });
    for (const d of idle.due) cmds.push(msg(d.to, d.work, { idleQueue: d.key }, `Your stream is free and ${d.work} ${d.assignment} (${d.kind}) is queued on it: start it.`));
    // A seat with unread messages is the wake loop's to remind; this nudges only a seat with nothing new to read.
    const unread = new Set(Object.values(state.messages).filter(m => !m.ackedAt).map(m => m.to));
    const owners = planIdleOwners({ seats: (fleet.others || []).filter(a => !unread.has(a.label)), works: state.work, watch: watches.idleOwners, now: fleet.now });
    for (const d of owners.due) cmds.push(msg(d.to, d.work, { idleOwner: `${d.to}/${fleet.now}` }, `You're idle and own ${d.count} open record(s). Next: ${d.work} ${quote(d.title)}. Work it, or progress it with what blocks it (--waitingOn) so it stops counting.`));
    watches = { workerStops: stops.watch, idleQueues: idle.watch, idleOwners: owners.watch };
    // herdr can report a finished worker as working (a spinner left on screen); an unchanged pane is the tell.
    for (const u of fleet.units) {
      const since = fleet.quiet?.[u.id], job = u.worker?.status === 'working' && workerJob(u, state.work);
      if (since == null || !job || fleet.now - since < (cfg.quietMs ?? 30 * 60000)) continue;
      const key = `${job[0].id}/${job[1].id}/${since}`;
      if (!told.has(`quietWorker:${key}`)) cmds.push(msg(u.supervisor.label, job[0].id, { quietWorker: key }, `${u.worker.label} shows as working, but its pane hasn't changed for ${Math.round((fleet.now - since) / 60000)} min while ${job[0].id} ${job[1].id} is started: read its pane; if it finished, record what it reported.`));
    }
  }
  // New work waits in intake for triage (V1's triage runs are gone): tell the triage seat once per record.
  if (cfg.triage?.since) for (const w of Object.values(state.work))
    if (['intake', 'proposed'].includes(w.phase) && !w.reconciled && w.createdAt >= cfg.triage.since && !told.has(`intake:${w.id}`))
      cmds.push(msg(cfg.triage.seat, w.id, { intake: w.id }, `${w.id} ${quote(w.title)} is in intake: triage it (ready, clarify with a question for Alex, or leave in intake with a note).`));
  // The board lead's hourly check-in (Alex, 2026-11-04): one message per hour, delivered like any other.
  const hour = cfg.checkIn?.now?.slice(0, 13);
  if (hour && !told.has(`checkIn:${hour}`)) cmds.push(msg(cfg.checkIn.seat, null, { checkIn: hour }, `Hourly check-in ${hour}:00Z: run your role file's check-in, file what you find as factory records, then ack this message.`));
  return { cmds, watches };
}
