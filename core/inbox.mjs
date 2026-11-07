// What each seat should find in its inbox: board requests, worker stops, idle queues and answers, as message commands.
// Pure. A message is created once per subject; waking the seat is the Wake port's job, not this one's.
import { isTrustedReviewSeat } from './capabilities.mjs';
import { BUILDING, LIVE_ASSIGNMENT } from './work.mjs';
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
 * @param cfg {supervisors, seats: labels that exist, router, cutoff, answersSince, v1Before, workers: {worker label: its supervisor}}
 * @param fleet {units, now, watches: {workerStops, idleQueues}} or null when the fleet couldn't be read
 * @returns {{cmds, watches}}
 */
// file.rb:N refs in a record's text, as [basename, line].
const refs = w => [...`${w.title} ${w.objective || ''}`.matchAll(/([\w.-]+\.[a-z]{1,4}):(\d+)/g)].map(m => [m[1], Number(m[2])]);
/** Open records citing the same file within 15 lines (W-269): a discovery the board likely already holds. */
function dupeNote(w, works) {
  const mine = refs(w), hits = [];
  if (!mine.length || w.kind === 'factory') return '';
  for (const o of Object.values(works)) {
    if (o.id === w.id || o.kind === 'factory' || ['done', 'cancelled'].includes(o.phase)) continue;
    const hit = refs(o).find(([f, n]) => mine.some(([g, m]) => f === g && Math.abs(n - m) <= 15));
    if (hit) hits.push(`${o.id} (${hit[0]}:${hit[1]})`);
  }
  return hits.length ? ` Likely duplicate of ${hits.join(', ')}: check before triaging; if so, withdraw it with a note there.` : '';
}

export function inboxCommands(state, cfg, fleet = null) {
  const told = toldKeys(state, cfg.v1Before), cmds = [];
  for (const e of eligibleRequests(state.work, cfg.cutoff, cfg.supervisors)) {
    if (!e.to || told.has(`requests:${e.key}`)) continue;
    cmds.push(msg(e.to, e.work, { requests: e.key }, `${e.key} ${e.type}${e.synthetic ? ' [SYNTHETIC]' : ''} ${quote(e.title)}: read the record and handle it per your role; ack the request when you have.${cfg.hostHowTo?.[e.to] ? ` Host stream: spawn this job's worker per ${cfg.hostHowTo[e.to]}.` : ''}`));
  }
  for (const [id, q] of Object.entries(state.questions)) {
    if (q.status !== 'answered' || !q.answer || told.has(`answers:${id}`) || q.answer.sentTo || (cfg.answersSince && q.answer.at < cfg.answersSince)) continue;
    const rec = state.work[q.work];
    // The router's pick wins; else the asking seat if it still exists, else the record's stream, else the router.
    const to = q.answer.routeTo || [q.from].find(f => cfg.seats.includes(f)) || (rec && routeOf(rec, cfg.supervisors)) || cfg.router;
    const text = `Answer to ${id}${q.from && q.from !== to ? ` (asked by ${q.from})` : ''}: ${[q.answer.choice && `(${q.answer.choice})`, q.answer.note].filter(Boolean).join(' ')}`;
    cmds.push(msg(to, q.work || null, { answers: id }, text));
    // The record's own seat hears it too when someone else asked (W-243).
    const own = rec && [rec.stream, rec.owner].find(x => x && x !== to && cfg.seats.includes(x));
    if (own) cmds.push(msg(own, q.work, { answers: id }, text));
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
    const owners = planIdleOwners({ seats: (fleet.others || []).filter(a => !unread.has(a.label) && !isTrustedReviewSeat(a.label)), works: state.work, watch: watches.idleOwners, now: fleet.now });
    for (const d of owners.due) cmds.push(msg(d.to, d.work, { idleOwner: `${d.to}/${fleet.now}` }, `You're idle and own ${d.count} open record(s). Next: ${d.work} ${quote(d.title)}. Work it, or park it with progress waitingOn (what blocks it) so it stops counting.`));
    watches = { workerStops: stops.watch, idleQueues: idle.watch, idleOwners: owners.watch };
    // A started assignment whose owner has no pane will never report (W-178). Stream workers have their own stop check.
    // ponytail: "sbx: " prefix stands in for "a stream's worker"; pass the worker labels if another worker naming appears.
    const live = new Set([...(fleet.others || []), ...fleet.units.flatMap(u => [u.supervisor, u.worker].filter(Boolean))].map(a => a.label));
    const lead = cfg.triage?.seat || 'board lead';
    for (const w of Object.values(state.work).filter(x => !['done', 'cancelled'].includes(x.phase))) for (const a of w.assignments || []) {
      const key = `${w.id}/${a.id}/v${a.version ?? 1}`;
      if (a.status !== 'started' || !a.owner || live.has(a.owner) || (cfg.seats || []).includes(a.owner) || /^sbx: /.test(a.owner) || told.has(`ghost:${key}`)) continue;
      cmds.push(msg(lead, w.id, { ghost: key }, `${w.id} ${a.id} (${a.kind}) is started by ${a.owner}, but no pane has that label, so it will never report. Re-dispatch it or have it cancelled (board developer: cancel).`));
    }
    // herdr can report a finished worker as working (a spinner left on screen); an unchanged pane is the tell.
    for (const u of fleet.units) {
      const since = fleet.quiet?.[u.id], job = u.worker?.status === 'working' && workerJob(u, state.work);
      if (since == null || !job || fleet.now - since < (cfg.quietMs ?? 30 * 60000)) continue;
      const key = `${job[0].id}/${job[1].id}/${since}`;
      if (!told.has(`quietWorker:${key}`)) cmds.push(msg(u.supervisor.label, job[0].id, { quietWorker: key }, `${u.worker.label} shows as working, but its pane hasn't changed for ${Math.round((fleet.now - since) / 60000)} min while ${job[0].id} ${job[1].id} is started: read its pane; if it finished, record what it reported.`));
    }
  }
  // A worker's own board note (sbx workers on the board) goes to its supervisor, which records what it means.
  for (const w of Object.values(state.work)) (w.updates || []).forEach((u, i) => {
    const sup = cfg.workers?.[u.by], key = `${w.id}/${i}`;
    if (sup && !told.has(`workerNote:${key}`)) cmds.push(msg(sup, w.id, { workerNote: key }, `${u.by} on ${w.id}: ${u.text}`));
  });  // A worker job the worker never wrote on: its session may lack the board tools (W-218), or the brief never started.
  const workerOf = Object.fromEntries(Object.entries(cfg.workers || {}).map(([wk, sup]) => [sup, wk]));
  for (const w of Object.values(state.work)) {
    const worker = workerOf[w.stream];
    if (!worker || !cfg.now) continue;
    for (const a of w.assignments || []) {
      const since = (a.history || []).filter(h => h.status === 'started').at(-1)?.at;
      const key = `${w.id}/${a.id}`;
      if (a.status !== 'started' || ![w.stream, worker].includes(a.owner) || !since || since < (cfg.workerSilentSince || '')
        || Date.parse(cfg.now) - Date.parse(since) < (cfg.workerSilentMs ?? 600000) || told.has(`workerSilent:${key}`)
        || (w.updates || []).some(u => u.by === worker && u.at >= since)) continue;
      cmds.push(msg(w.stream, w.id, { workerSilent: key }, `${w.id} ${a.id} started at ${since.slice(11, 16)}Z and ${worker} hasn't written on it. Check its pane: if it says the software-factory tools are missing, restart it (a fresh session loads them); if the brief never started, re-send it. Every brief asks for a progress note at start.`));
    }
  }

  // A building record whose request was acked "received" but never assigned holds its stream (dispatch counts it running).
  if (cfg.now) for (const w of Object.values(state.work)) {
    const r = (w.requests || []).at(-1), to = routeOf(w, cfg.supervisors), key = r && `${w.id}/${r.id}`;
    if (!to || !BUILDING.includes(w.phase) || r?.ack?.outcome !== 'received' || told.has(`heldIdle:${key}`)
      || Date.parse(cfg.now) - Date.parse(r.ack.at) < (cfg.heldIdleMs ?? 900000)
      || (w.assignments || []).some(a => LIVE_ASSIGNMENT.includes(a.status))) continue;
    cmds.push(msg(to, w.id, { heldIdle: key }, `${w.id} ${quote(w.title)} is in ${w.phase} with ${r.id} acked "received" and nothing assigned, so it holds your stream. Assign it, or if it waits on someone, park it (assign, then progress --stage blocked --waitingOn) so the stream takes other work.`));
  }
  // Board bugs reach the board developer's pane like stream work reaches a supervisor (W-211): once per new record it
  // owns, and once per note someone else adds after developerSince. Parked records wait quietly.
  if (cfg.developer) for (const w of Object.values(state.work)) {
    if (![w.stream, w.owner].includes(cfg.developer) || ['done', 'cancelled'].includes(w.phase) || w.waitingOn) continue;
    if (!told.has(`devRecord:${w.id}`)) cmds.push(msg(cfg.developer, w.id, { devRecord: w.id }, `${w.id} ${quote(w.title)} is yours (board developer): read it and work it, or park it with progress waitingOn.`));
    else {
      // Notes from before the record's own notice are its setup (created, owner set), which the notice already covers.
      const since = [cfg.developerSince || '', Object.values(state.messages).find(m => m.about?.devRecord === w.id)?.at || ''].sort().at(-1);
      (w.updates || []).forEach((u, i) => {
      if (i === 0 || u.by === cfg.developer || u.at <= since || told.has(`devNote:${w.id}/${i}`)) return;
      cmds.push(msg(cfg.developer, w.id, { devNote: `${w.id}/${i}` }, `${u.by} on ${w.id}: ${u.text}`));
      });
    }
  }
  // New work waits in intake for triage (V1's triage runs are gone): tell the triage seat once per record.
  if (cfg.triage?.since) for (const w of Object.values(state.work))
    if (['intake', 'proposed'].includes(w.phase) && !w.reconciled && w.createdAt >= cfg.triage.since && !told.has(`intake:${w.id}`))
      cmds.push(msg(cfg.triage.seat, w.id, { intake: w.id }, `${w.id} ${quote(w.title)} is in intake: triage it (ready, clarify with a question for Alex, or leave in intake with a note).${dupeNote(w, state.work)}`));
  // The board lead's hourly check-in (Alex, 2026-11-04): one message per hour, delivered like any other.
  const hour = cfg.checkIn?.now?.slice(0, 13);
  if (hour && !told.has(`checkIn:${hour}`)) cmds.push(msg(cfg.checkIn.seat, null, { checkIn: hour }, `Hourly check-in ${hour}:00Z: run your role file's check-in, file what you find as factory records, then ack this message.`));
  return { cmds, watches };
}
