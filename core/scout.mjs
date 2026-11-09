// The Sentry scout (Alex, 11-09): a free stream with nothing to dispatch looks in Sentry for errors worth a small fix.
// Pure: the server creates the record the plan names, and auto-dispatch sends it like any job.
import { busyStreams, canTake } from './dispatch.mjs';
import { TERMINAL } from './work.mjs';

/** Sentry issue ids (from issue URLs) and short ids of the scanned projects cited anywhere on the board. */
export function sentryCited(works, projects) {
  // ponytail: a bare numeric id with no URL isn't recognised; cite the URL.
  const names = [...projects].sort((a, b) => b.length - a.length).map(p => p.toUpperCase()).join('|');
  const short = new RegExp(`\\b(?:${names})-(?=[0-9A-Z]*\\d)[0-9A-Z]+\\b`, 'g'), out = new Set();
  for (const w of works) {
    const text = [w.title, w.objective, ...Object.values(w.links || {}), ...(w.updates || []).map(u => u.text)].join('\n');
    for (const m of text.matchAll(/sentry\.io\/(?:organizations\/[\w-]+\/)?issues\/(\d+)/g)) out.add(m[1]);
    for (const m of text.matchAll(short)) out.add(m[0]);
  }
  return [...out].sort();
}

/** The scout's brief, one template. */
export function scoutBrief({ projects, maxProposals }, skip) {
  return [
    `Sentry scout: find up to ${maxProposals} production errors worth a small, safe fix in built-rails. No code, no branch, no PR.`,
    `1. List unresolved issues seen in the last 14 days in the Sentry projects ${projects.join(', ')} (no other project), ranked by users affected, then event count.`,
    `2. Skip issues the board already tracks: ${skip.length ? skip.join(', ') : 'none yet'}.`,
    `3. WWBD: "Before building, confirm the thing is actually broken and actually matters." For at most ${maxProposals} candidates, trace the stack to the failing frame (file:line), try to reproduce it, and decide whether a small, safe fix exists. Skip noise (bots, third-party, already fixed on main) and anything too big to be small.`,
    `4. File each as a progress discovery on this record. discovery: one line naming the error and its file:line. text: the Sentry link, events and users affected, first and last seen, the failing frame file:line, the root cause labelled "reproduced" or "not reproduced", and the proposed fix scope.`,
    `5. Finish with a progress note: how many you filed and why each other candidate was skipped.`,
  ].join('\n');
}

/**
 * @param plan this tick's autoDispatchPlan @param cfg {supervisors, drain, scout: {projects, maxProposals, gapHours, maxUntriaged}}
 * @returns {to, create} for the record to create, or {reason} why no scout runs now
 */
export function scoutPlan(works, plan, cfg, now) {
  const sc = cfg.scout;
  if (!sc) return { reason: 'no scout config' };
  if (plan.some(p => p.action)) return { reason: 'work is being dispatched' };
  const scouts = works.filter(w => w.kind === 'scout');
  const open = scouts.find(w => !TERMINAL.includes(w.phase));
  if (open) return { reason: `${open.id} is open` };
  const last = scouts.map(w => w.completion?.at || w.updatedAt).sort().at(-1);
  if (last && Date.parse(now) - Date.parse(last) < sc.gapHours * 3600000) return { reason: `the last scout closed at ${last}` };
  const ids = new Set(scouts.map(w => w.id));
  const untriaged = works.filter(w => ids.has(w.proposedFrom) && ['intake', 'proposed'].includes(w.phase)).length;
  if (untriaged >= sc.maxUntriaged) return { reason: `${untriaged} scout proposals wait for triage` };
  // canTake with no repo: a built-rails job, so host streams never scout.
  const busy = busyStreams(works, cfg), to = Object.keys(cfg.supervisors).find(l => !busy.has(l) && canTake({}, l, cfg.supervisors));
  if (!to) return { reason: 'no free sbx stream' };
  return { to, create: { title: `Sentry scout ${now.slice(0, 10)} ${now.slice(11, 16)}Z`, objective: scoutBrief(sc, sentryCited(works, sc.projects)),
    kind: 'scout', repo: 'built-rails', owner: to, phase: 'ready', priority: 4, source: { type: 'agent', by: 'board (scout)' } } };
}
