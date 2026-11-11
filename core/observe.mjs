// Turning source reads into observations and, where they change a record, into commands. Pure: callers do the I/O and
// decide whether to append (live) or only log (shadow).
import * as W from './work.mjs';
import { sourceIndex } from './correlate.mjs';

const stripHtml = s => String(s || '').replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\n{3,}/g, '\n\n').trim();

export const prUrlKey = (u, owner) => { const m = String(u || '').match(new RegExp(`^https://github\\.com/${owner}/([\\w.-]+)/pull/(\\d+)(?:[/?#]|$)`)); return m ? `${m[1]}:${m[2]}` : null; };
export const recordPrKey = (w, owner) => w.source?.type === 'pr' ? w.source.key.replace(/-(\d+)$/, ':$1') : prUrlKey(w.links?.pr, owner);

/**
 * threads.sh output lines → {prs: Map(id → PR item), heads: Map(repo:num → {sha, isDraft})}.
 * Every PR yields a head; only Alex's own open PRs (`own`), or any PR with threads when `own` is null, become items.
 */
export function projectPrs(lines, own = null) {
  const prs = new Map(), heads = new Map();
  for (const line of lines) {
    const pr = typeof line === 'string' ? JSON.parse(line) : line;
    heads.set(`${pr.repo}:${pr.number}`, { sha: pr.headRefOid, isDraft: pr.isDraft });
    if ((own && !own.has(`${pr.repo}:${pr.number}`)) || (!own && !pr.threads.length)) continue;
    const id = `${pr.repo}-${pr.number}`;
    prs.set(id, {
      id, kind: 'pr', repo: pr.repo, number: pr.number, ref: `${pr.repo}#${pr.number}`, title: pr.title, url: pr.url,
      base: pr.baseRefName, branch: pr.headRefName, head: pr.headRefOid, isDraft: !!pr.isDraft, noFeedback: !pr.threads.length,
      threads: { human: pr.threads.filter(t => !t.bot).length, bot: pr.threads.filter(t => t.bot).length },
      threadKey: pr.threads.map(t => t.id).sort().join(','), threadList: pr.threads,
    });
  }
  return { prs, heads };
}

/** Projected Teamwork tasks → Map(tw-id → task item). An epic (undated, top-level, with subtasks listed) is not work. */
export function projectTasks(tasks, site, supportProjects = []) {
  const parents = new Set(tasks.map(t => t.parentTaskId).filter(Boolean));
  const out = new Map();
  for (const t of tasks) {
    if (!t.dueDate && !t.parentTaskId && parents.has(t.id)) continue;
    out.set(`tw-${t.id}`, {
      id: `tw-${t.id}`, kind: 'task', ref: String(t.id), title: t.name, status: t.status, due: t.dueDate,
      url: `https://${String(site || 'teamwork.invalid').replace(/^https?:\/\//, '')}/app/tasks/${t.id}`,
      description: stripHtml(t.description), parentTaskId: t.parentTaskId, updatedAt: t.updatedAt,
      ...(supportProjects.includes(t.projectId) ? { support: true } : {}),
    });
  }
  return out;
}

/** The Teamwork task a record is about: its own key or an alias (tw-n), else the task id ending its PR branch. */
export function taskIdOf(w) {
  const tw = [w.source?.key, ...(w.aliases || [])].find(k => /^tw-\d+$/.test(k || ''));
  return tw ? tw.slice(3) : String(w.links?.branch || '').match(/\/(\d{6,})$/)?.[1] || null;
}

/**
 * observe_project commands: each live record's project is its task's top-level parent (Alex, 11-04: "parent").
 * @param tops Map taskId → {id, name} of the top-level ancestor (the task itself when it has no parent)
 */
export function projectCommands(state, tops) {
  const out = [];
  for (const w of Object.values(state.work)) {
    if (W.TERMINAL.includes(w.phase)) continue;
    const top = tops.get(taskIdOf(w));
    if (top && (w.project?.id !== top.id || w.project?.name !== top.name)) out.push({ kind: 'observe_project', target: w.id, payload: { id: top.id, name: top.name } });
  }
  return out;
}

const sansCheckTime = w => JSON.stringify({ ...w, headVerified: w.headVerified && { ...w.headVerified, at: null } });

/**
 * observe_head / unverify_head commands for live records whose PR head GitHub just reported (or no longer shows).
 * A poll that only re-confirms the same head yields nothing, so the log records changes, not polls.
 */
export function headCommands(state, heads, { owner, now, standingWaiver, ancestry = new Map() }) {
  const cmds = [];
  for (const w of Object.values(state.work)) {
    const key = recordPrKey(w, owner);
    if (!key || W.TERMINAL.includes(w.phase)) continue;
    const h = heads.get(key), a = ancestry.get(w.id);
    const cmd = h ? { kind: 'observe_head', target: w.id, payload: { sha: h.sha, via: 'github', isDraft: h.isDraft, ...(a ? { ancestry: a } : {}) } } : { kind: 'unverify_head', target: w.id, payload: {} };
    const ctx = { now, by: 'github', ...(h ? { standingWaiver } : {}) };
    const after = h ? W.observeHead(w, cmd.payload, ctx) : W.unverifyHead(w, ctx);
    if (sansCheckTime(after) !== sansCheckTime(w)) cmds.push({ ...cmd, ctx });
  }
  return cmds;
}

/** Compare reads the poller owes before headCommands: a reviewed PR's head whose descent from the reviewed head isn't read yet. */
export function ancestryWanted(state, heads, owner) {
  return Object.values(state.work).flatMap(w => {
    const key = recordPrKey(w, owner), h = key && !W.TERMINAL.includes(w.phase) && heads.get(key), base = h && W.ancestryBase(w, h.sha);
    return base ? [{ id: w.id, repo: key.split(':')[0], base, head: h.sha }] : [];
  });
}

/**
 * observe_health commands for Alex's PRs into main whose merge or CI state at the record's head needs work.
 * @param health Map(repo:num → {head, base, conflict, failing}); a PR GitHub hasn't finished computing says neither.
 */
export function healthCommands(state, health, { owner, now, exclude, mainGreen = new Map(), branches = new Map() }) {
  const cmds = [], idx = sourceIndex(state), acting = w => w && [...W.BUILDING, ...W.HEALTH_REOPENS].includes(w.phase);
  // One fixes round per PR: the PR's own record when it is in play, else the first record carrying the PR that is.
  const byPr = new Map();
  for (const w of Object.values(state.work)) { const k = recordPrKey(w, owner); if (k && acting(w)) byPr.set(k, [...(byPr.get(k) || []), w]); }
  for (const [key, ws] of byPr) {
    // The record already fixing this PR takes its new findings (W-377), else the PR's own record, else the first in play.
    const fixer = ws.find(r => (r.assignments || []).some(a => a.kind === 'fixes' && ['queued', 'started'].includes(a.status)));
    const own = state.work[idx.get(key.replace(':', '-'))], w = fixer || (acting(own) ? own : ws[0]);
    const h = health.get(key);
    if (!h || W.trackOf(w, { exclude }) === 'excluded') continue;
    // A stacked PR's CI and conflicts are judged against its base, not main; its review feedback is still ours to work.
    const onMain = h.base === 'main';
    // W-375: a stacked PR's failing check is ours when its base PR (read this tick) passes it.
    const repo = key.split(':')[0], baseId = !onMain && [...branches].find(([id, b]) => b === h.base && id.startsWith(`${repo}-`))?.[0];
    const baseFailing = baseId && health.get(baseId.replace(/-(\d+)$/, ':$1'))?.failing;
    const failing = onMain ? h.failing : baseFailing ? h.failing.filter(f => !baseFailing.includes(f)) : [];
    const payload = { head: h.head, conflict: onMain && h.conflict, failing, changesRequested: h.changesRequested || [], threads: h.threads || [], comments: h.comments || [], mainGreen: onMain && mainGreen.get(key.split(':')[0]) || null };
    if (W.observeHealth(w, payload, { now, by: 'github' }) !== w) cmds.push({ kind: 'observe_health', target: w.id, payload, ctx: { now, by: 'github' } });
  }
  return cmds;
}

/**
 * The hourly audit (local-head's sweep, as code): what this GitHub read saw that no record holds. An own PR with no
 * live record, and feedback whose id no finding carries. Mutation PRs are Alex's own and stay off the board.
 * @param prs projectPrs' map (id repo-n → {branch}), so a Mutation PR with no record is known by its branch
 * @returns [{key, id ('pr' for a missing record), by?, url?}]
 */
export function auditMissed(state, own, health, { owner, exclude, prs = new Map() }) {
  const works = Object.values(state.work), told = new Set(works.flatMap(w => (w.findings || []).flatMap(f => f.source?.ids || [])));
  const out = [];
  for (const key of own) {
    const recs = works.filter(w => recordPrKey(w, owner) === key || (w.aliases || []).includes(key.replace(':', '-')));
    const branch = prs.get(key.replace(':', '-'))?.branch;
    if ([...recs, ...(branch ? [{ links: { branch } }] : [])].some(w => W.trackOf(w, { exclude }) === 'excluded')) continue;
    // A PR a record replaced (an alias that isn't its own PR) was settled on that record, open or not.
    if (!recs.some(w => !W.TERMINAL.includes(w.phase))) { if (!recs.some(w => recordPrKey(w, owner) !== key)) out.push({ key, id: 'pr' }); continue; }
    const h = health.get(key);
    for (const x of [...(h?.changesRequested || []), ...(h?.threads || []), ...(h?.comments || [])]) if (!told.has(x.id)) out.push({ key, id: x.id, by: x.by, url: x.url });
  }
  return out;
}
