// What each seat should find in its inbox: board requests, worker stops, idle queues and answers, as message commands.
// Pure. A message is created once per subject; waking the seat is the Wake port's job, not this one's.
import { eligibleRequests, planWorkerStops, planIdleQueues, routeOf, PREFIX } from './notifier.mjs';

/** Subjects already told: V2 messages, and V1 notifications imported before cutover (so nobody is told twice). */
export function toldKeys(state) {
  const told = new Set();
  for (const m of Object.values(state.messages)) for (const [k, v] of Object.entries(m.about || {})) for (const x of [v].flat()) told.add(`${k}:${x}`);
  for (const n of Object.values(state.notifications)) {
    if (n.status !== 'submitted') continue;
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
 * @param cfg {supervisors, seats: labels that exist, router, cutoff, answersSince}
 * @param fleet {units, now, watches: {workerStops, idleQueues}} or null when the fleet couldn't be read
 * @returns {{cmds, watches}}
 */
export function inboxCommands(state, cfg, fleet = null) {
  const told = toldKeys(state), cmds = [];
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
    for (const d of stops.due) if (!told.has(`workerStop:${d.work}/${d.assignment}`))
      cmds.push(msg(d.to, d.work, { workerStop: `${d.work}/${d.assignment}` }, `${d.worker} stopped while ${d.work} ${d.assignment} is started: read its pane and record what it reported.`));
    const sent = Object.fromEntries([...told].filter(k => k.startsWith('idleQueue:')).map(k => [k.slice(10), true]));
    const idle = planIdleQueues({ units: fleet.units, works: state.work, watch: watches.idleQueues, sent, now: fleet.now, supervisors: cfg.supervisors });
    for (const d of idle.due) cmds.push(msg(d.to, d.work, { idleQueue: d.key }, `Your stream is free and ${d.work} ${d.assignment} (${d.kind}) is queued on it: start it.`));
    watches = { workerStops: stops.watch, idleQueues: idle.watch };
  }
  return { cmds, watches };
}
