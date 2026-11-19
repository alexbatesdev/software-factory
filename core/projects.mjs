// Projects (Alex, 11-16; ~/Code/plans/software-factory-v2/projects-design.md): a planning-repo project joined to its
// Teamwork tree. Each leaf task is one PR (D-013); progress is finished leaves over all leaves. Pure, read-only.
import { createHash } from 'node:crypto';
import { BUILDING, REVIEWING, ownTasks } from './work.mjs';

/**
 * Whether a leaf may start (Alex 11-16, decision 5): the spec has REQ IDs, the leaf has a test plan, and no open decision
 * names its task or a REQ its plan covers. A decision tied to no task or REQ shows on the project but holds no leaf.
 */
export function leafGate(pl, taskId) {
  const reasons = [], reqs = pl.testPlanReqs?.[taskId] || [];
  if (!pl.reqs) reasons.push(`the project's spec.md has no requirements (REQ IDs)`);
  if (!(pl.testPlans || []).includes(taskId)) reasons.push(`no test plan for task ${taskId} in projects/${pl.slug}/test-plans/`);
  // Phase C: the factory's own plan, merged by Alex, comes before any task starts; its open questions hold like the team's.
  if (!pl.factoryPlan) reasons.push(`no factory implementation plan on project-planning main (projects/${pl.slug}/factory/implementation-plan.md)`);
  for (const d of [...(pl.decisions || []), ...(pl.factoryDecisions || [])]) {
    const req = reqs.find(r => new RegExp(`\\b${r}\\b`).test(d.text || ''));
    if (req) reasons.push(`open decision ${d.id} (${d.title}) covers ${req}`);
    else if (new RegExp(`\\b${taskId}\\b`).test(d.text || '')) reasons.push(`open decision ${d.id} (${d.title}) names task ${taskId}`);
  }
  return { ready: !reasons.length, reasons };
}

const taskOf = w => w.source?.key?.match(/^tw-(\d+)$/)?.[1] || String(w.links?.teamwork || w.links?.source || '').match(/teamwork\.com\/app\/tasks\/(\d+)/)?.[1] || null;
const stateOf = w => w.phase === 'done' ? 'done' : w.phase === 'cancelled' ? 'cancelled'
  : ['awaiting_human_approval', 'ready_for_human', 'awaiting_alex_review'].includes(w.phase) ? 'awaiting approval'
  : REVIEWING.includes(w.phase) ? 'in review' : BUILDING.includes(w.phase) ? 'building' : 'queued';

/**
 * @param planning [{slug, readme: parseReadme(), reqs, openDecisions, testPlans: [task ids]}]
 * @param trees {rootTaskId: [{id, name, parent, status}]} each project's Teamwork tree below its root
 * @param prs Map(id → {url, number, title, branch, base, isDraft}) Alex's open PRs
 * @returns {projects, loose} loose: open PRs on no project's leaf
 */
export function buildProjects({ planning, trees, works, prs, teamPrs = [], me = null, meName = null }) {
  const byTask = new Map(), byPr = new Map();
  for (const w of Object.values(works)) { const t = taskOf(w); if (t && !byTask.has(t)) byTask.set(t, w); if (w.links?.pr) byPr.set(w.links.pr, w); }
  const open = [...prs.values()], others = teamPrs.filter(p => p.author !== me && !open.some(o => o.url === p.url));
  const byBranch = new Map([...others, ...open].map(p => [p.branch, p])), used = new Set();
  const prView = p => p && { url: p.url, number: p.number, title: p.title, draft: !!p.isDraft, stackedOn: byBranch.get(p.base)?.number ?? null, author: p.author || me };
  const projects = planning.map(pl => {
    const root = pl.readme.teamworkTask, tree = trees[root];
    const kids = new Map(); for (const n of tree || []) kids.set(n.parent, [...(kids.get(n.parent) || []), n]);
    const leaves = [];
    const walk = (id, path) => { for (const n of kids.get(id) || []) {
      if (kids.has(n.id)) { walk(n.id, [...path, n.name]); continue; }
      const pr = open.find(p => new RegExp(`tw-${n.id}(?!\\d)`).test(p.branch)) || open.find(p => p.url === byTask.get(n.id)?.links?.pr)
        || others.find(p => (p.tasks || []).includes(n.id) || new RegExp(`tw-${n.id}(?!\\d)`).test(p.branch)); // a teammate's PR (phase D)
      const w = byTask.get(n.id) || (pr && byPr.get(pr.url)) || null;
      if (pr) used.add(pr.url);
      leaves.push({ task: n.id, name: n.name, path: [...path, n.name].join(' / '), state: n.status === 'completed' ? 'done' : w ? stateOf(w) : pr ? 'PR open' : 'not started',
        work: w?.id || null, pr: prView(pr), testPlan: (pl.testPlans || []).includes(n.id), testPlanPath: pl.testPlanFiles?.[n.id] || null, gate: leafGate(pl, n.id) });
    } };
    if (tree) walk(root, []);
    const out = { slug: pl.slug, title: pl.readme.title, stage: pl.readme.stage, status: pl.readme.status, owner: pl.readme.owner, teamworkTask: root,
      reqs: pl.reqs, openDecisions: pl.openDecisions, decisions: (pl.decisions || []).map(d => ({ id: d.id, title: d.title })), treeRead: !!tree, factoryPlan: !!pl.factoryPlan,
      developers: [...new Set((tree || []).filter(n => !kids.has(n.id)).flatMap(n => n.assignees || []))], leaves, progress: { done: leaves.filter(l => l.state === 'done').length, total: leaves.length } };
    // Alex's project (11-19, the page's "just mine"): his PR on a task, a factory record on one, or he owns it or is assigned.
    const devs = new Set((tree || []).flatMap(n => n.assignees || []));
    out.mine = leaves.some(l => l.work || (l.pr && l.pr.author === me)) || (!!meName && (pl.readme.owner === meName || devs.has(meName)));
    return out;
  });
  // Phase D: the team's open PRs (not Alex's), by author, with their stacks. Read-only.
  const team = others.map(prView).sort((a, b) => a.author.localeCompare(b.author) || a.number - b.number);
  return { projects, loose: open.filter(p => !used.has(p.url)).map(prView), team };
}

// Phase C: the planning job (Alex 11-16). It runs on the stream that has project-planning, through a PR Alex merges.
export const PLANNING_REPO = 'project-planning';
const NOT_BUILT = ['proposed', 'intake', 'clarification', 'ready', 'queued'];
const keyOf = p => `project:${p.slug}`;

/** One create per project the factory is about to work (one of its tasks has a record not built yet) with no plan on main and no open planning job. */
export function triageCreates(projects, works, cfg = {}) {
  const open = new Set(Object.values(works).filter(w => !['done', 'cancelled'].includes(w.phase)).map(w => w.source?.key).filter(Boolean));
  return projects.filter(p => !p.factoryPlan && !['Archived', 'Complete'].includes(p.status) && !open.has(keyOf(p))
    && p.leaves.some(l => l.work && NOT_BUILT.includes(works[l.work]?.phase) && !works[l.work]?.links?.pr))
    .map(p => ({ title: `Plan project: ${p.title || p.slug}`, objective: triageObjective(p, cfg), kind: 'build', repo: PLANNING_REPO, phase: 'ready', priority: 2,
      source: { type: 'agent', by: 'factory (projects)', key: keyOf(p) } }));
}

/** The planning job's brief: the record's objective, so the supervisor briefs from it and nothing Built-specific lives in this repo. */
export function triageObjective(p, { questionsTo = 'alex' } = {}) {
  const built = l => !!l.pr || ['done', 'cancelled', 'awaiting approval', 'in review'].includes(l.state);
  const dir = `projects/${p.slug}`, todo = p.leaves.filter(l => !built(l)), missing = todo.filter(l => !l.testPlan), list = ls => ls.map(l => `${l.task} ${l.name}`).join('; ');
  const route = questionsTo === 'owner' ? `put needs: ${p.owner || 'the README Owner'} on the entry, and list them in the PR body for Alex to forward`
    : questionsTo === 'developers' ? `put needs: ${p.developers.join(', ') || "the tasks' assignees"} on the entry, and list them in the PR body for Alex to forward`
    : 'have your supervisor file each one as an ask on this record (distinct, one decision each) and put its TB-n in the entry\'s refs';
  return [
    `Plan the project ${p.title || p.slug} (${dir} in builtforteams/project-planning) so its tasks can be built without raising anything to Alex. Alex merges the result; nothing here is final until he does.`,
    `Repo and branch: project-planning, branch alex/factory/${p.slug}-plan from origin/main. Never commit or push to main, even though the repo's own skills do: one draft PR, ordinary pushes only, and Alex merges it.`,
    `Read first, in full: ${dir}/README.md, intent.md, spec.md, decisions.md, discussion.md, plan.md and test-plans/ if present, and templates/decisions.md. The Teamwork tree (top task ${p.teamworkTask}): plan these ${todo.length} task(s): ${list(todo)}.${todo.length < p.leaves.length ? ` Already built or done (context only): ${list(p.leaves.filter(built))}.` : ''}`,
    `Write ${dir}/factory/implementation-plan.md: for each task to plan, the approach, the code areas it touches, the order and which PRs stack, risks, and every edge case and ambiguity with how it is settled (cite REQ IDs and D-/FD- entries). Workers follow it, so write it for someone with the repo and none of this context.`,
    `Write ${dir}/factory/decisions.md in templates/decisions.md's format, numbered FD-001 upward (never reuse the team's D- numbers): one entry per ambiguity you found. Settle what the spec, the team's decisions or the codebase answers (say which, with the source). What only a person can answer stays status: open; for each, ${route}.`,
    missing.length ? `Draft the missing test plans in the same PR, following project-planning's built-test-plans skill (plugins/built-intent/skills/built-test-plans) for format and rules, but skipping its commit to main: ${list(missing)}.` : 'Every task to plan already has a test plan; bring any that disagree with the spec back in line.',
    'Review before you report: a fresh subagent reads the plan, the decision log and the test plans against the spec and the team decisions for gaps, contradictions and unanswered edge cases. Fix what it finds. The built-rails review lenses do not apply to this repo.',
    'Stop when the draft PR is open and pushed: report the PR, the pushed head SHA, and the FD entries left open.',
  ].join('\n\n');
}

/** The Teamwork tasks a project names as its root: the README's Teamwork row and the spec's teamwork_task. */
export const projectRoots = p => [...new Set([p.readme?.teamworkTask, p.spec?.teamworkTask].filter(Boolean))];

/**
 * Phase 2: the spec and requirements a record is built against (architecture decision 11). Observation only so far.
 * @param read {planning: [readPlanning row] | null, trees: {root: [{id, parent}]}}
 * @returns {status: resolved | no spec | ambiguous | unavailable, reason?, slug?, commit?, specBlob?, tasks?, reqs?}
 */
export function resolveSpec(w, { planning, trees }) {
  const tasks = [...ownTasks(w)];
  if (!tasks.length) return { status: 'no spec', reason: 'no Teamwork task' };
  if (!planning) return { status: 'unavailable', reason: 'project-planning not read yet' };
  // The factory's recorded top-level parent (observe_project) places the record without reading every tree.
  const top = w.project?.id ? String(w.project.id) : null, hits = new Map(), unread = [];
  for (const p of planning) {
    const roots = projectRoots(p);
    for (const root of roots) {
      const tree = trees[root], kids = new Map();
      for (const n of tree || []) kids.set(n.parent, [...(kids.get(n.parent) || []), n.id]);
      const below = id => (kids.get(id) || []).flatMap(k => [k, ...below(k)]), all = new Set([root, ...below(root)]);
      const mine = top === root ? tasks : tasks.filter(t => all.has(t));
      if (!mine.length) { if (!tree && !top) unread.push(p.slug); continue; }
      // Without the tree, a task with its own test plan is a leaf; any other task below the root can't be expanded.
      if (!tree && mine.some(t => t !== root && !p.testPlanReqs?.[t])) return { status: 'unavailable', reason: `Teamwork tree not read for ${p.slug}` };
      const leaves = mine.flatMap(t => kids.has(t) ? below(t).filter(k => !kids.has(k)) : [t]);
      hits.set(p.slug, { p, mine, leaves, split: roots.length > 1 });
    }
  }
  if (hits.size > 1) return { status: 'ambiguous', reason: `tasks ${tasks.join(', ')} are in ${[...hits.keys()].join(' and ')}` };
  if (!hits.size) return unread.length ? { status: 'unavailable', reason: `Teamwork tree not read for ${unread.join(', ')}` } : { status: 'no spec', reason: 'task is in no project' };
  const [{ p, mine, leaves, split }] = hits.values();
  if (split) return { status: 'ambiguous', reason: `${p.slug}: README names task ${p.readme.teamworkTask}, spec names ${p.spec.teamworkTask}` };
  const ids = [...new Set(leaves.flatMap(t => p.testPlanReqs?.[t] || []))].sort();
  return { status: 'resolved', slug: p.slug, commit: p.commit, specBlob: p.specBlob, tasks: mine,
    reqs: Object.fromEntries(ids.filter(id => p.spec?.reqs?.[id]).map(id => [id, { text: p.spec.reqs[id].text, removed: p.spec.reqs[id].removed }])),
    ...(ids.some(id => !p.spec?.reqs?.[id]) ? { missing: ids.filter(id => !p.spec?.reqs?.[id]) } : {}),
    ...(leaves.some(t => !p.testPlanReqs?.[t]) ? { untested: leaves.filter(t => !p.testPlanReqs?.[t]) } : {}) };
}

/** Every open record's spec resolution, and the pin of its latest work assignment (phase 2), for /api/specs. Counts by status first. */
export function specView(state, read) {
  const rows = Object.values(state.work).filter(w => !['done', 'cancelled'].includes(w.phase)).map(w => {
    const a = [...(w.assignments || [])].reverse().find(a => BUILDING.includes(a.kind) && state.manifests?.[`${w.id}/${a.id}/1`]?.spec);
    const p = a && state.manifests[`${w.id}/${a.id}/1`].spec;
    const now = resolveSpec(w, read);
    return { id: w.id, title: w.title, phase: w.phase, ...now,
      ...(p ? { pinned: { assignment: a.id, status: p.status, commit: p.commit || null, specBlob: p.specBlob || null, reqs: Object.keys(p.reqs || {}) }, delta: specDelta(p, now) } : {}) };
  });
  const counts = {}; for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return { counts, rows };
}

/**
 * What changed in a record's requirements since its pin (phase 2): null when nothing did. A requirement struck out, or gone
 * from the test plan's set, is removed. A pinned contract that can't be compared now says why rather than reading as unchanged.
 */
export function specDelta(pin, now) {
  if (pin?.status !== 'resolved') return null;
  if (now?.status !== 'resolved' || now.slug !== pin.slug) return { unavailable: now?.status === 'resolved' ? `now resolves to ${now.slug}` : now?.status || 'unknown' };
  const live = r => r && !r.removed, was = pin.reqs || {}, is = now.reqs || {};
  const added = Object.keys(is).filter(id => live(is[id]) && !live(was[id])).sort();
  const changed = Object.keys(is).filter(id => live(is[id]) && live(was[id]) && is[id].text !== was[id].text).sort();
  const removed = Object.keys(was).filter(id => live(was[id]) && !live(is[id])).sort();
  return added.length || changed.length || removed.length ? { added, changed, removed } : null;
}

const PREFIX = '[software factory, automated, not Alex]';
const clip = t => (t.length > 300 ? `${t.slice(0, 297)}...` : t);

/**
 * A spec edit during a job, on an enabled project (architecture decision 11): added or changed REQs become an in-scope
 * finding (a fixes round once nothing runs), a removed REQ is a question to Alex, and the supervisor hears once per
 * assignment and spec version. The job's brief and pin stay as they were.
 */
export function specFollowUps(state, read, { slugs = [] } = {}) {
  const told = new Set(Object.values(state.messages || {}).flatMap(m => [m.about?.specDelta].flat()).filter(Boolean)), out = [];
  for (const w of Object.values(state.work)) {
    if (['done', 'cancelled'].includes(w.phase)) continue;
    const a = [...(w.assignments || [])].reverse().find(a => BUILDING.includes(a.kind) && state.manifests?.[`${w.id}/${a.id}/1`]?.spec);
    const pin = a && state.manifests[`${w.id}/${a.id}/1`].spec;
    if (!pin || !slugs.includes(pin.slug)) continue;
    const now = resolveSpec(w, read), d = specDelta(pin, now);
    if (!d || d.unavailable) continue;
    // Each change is told once: a later edit elsewhere in the spec doesn't file it again, a second edit to it does.
    const keyOf = (id, how) => `${w.id}/${a.id}/${id}:${how === 'removed' ? 'removed' : createHash('sha1').update(now.reqs[id].text).digest('hex').slice(0, 10)}`;
    const fresh = how => d[how].filter(id => !told.has(keyOf(id, how)));
    const added = fresh('added'), changed = fresh('changed'), removed = fresh('removed');
    if (!added.length && !changed.length && !removed.length) continue;
    const where = `projects/${pin.slug}/spec.md (project-planning ${pin.commit?.slice(0, 7)} to ${now.commit?.slice(0, 7)})`, cmds = [], said = [];
    if (added.length || changed.length) {
      const rows = [...added.map(id => `${id} added: "${clip(now.reqs[id].text)}"`), ...changed.map(id => `${id} changed, now: "${clip(now.reqs[id].text)}"`)];
      cmds.push({ kind: 'event', target: w.id, payload: { type: 'discovery', inScope: true, text: `The spec changed after ${a.id} was briefed (${where}). ${rows.join('; ')}. Build to the new text; the rest of the brief stands.` } });
      said.push(`${[...added, ...changed].join(', ')} added or changed: an open finding on ${w.id} carries it`);
    }
    if (removed.length) {
      cmds.push({ kind: 'ask', payload: { work: w.id, promptedBy: `spec change in ${where}. ${removed.map(id => `${id} was: "${clip(pin.reqs[id].text)}"`).join('; ')}`,
        title: `${w.id}: the spec dropped ${removed.join(', ')} after ${a.id} was briefed. Take what was built for ${removed.length > 1 ? 'them' : 'it'} out of the PR?`,
        options: [{ key: 'a', text: 'Take it out in a fixes round (the spec wins)' }, { key: 'b', text: 'Keep it as built; the spec stays as it is' }, { key: 'c', text: 'Keep it; the spec should get the requirement back' }], recommend: 'a',
        why: 'Architecture decision 11: a removed requirement is a question to Alex, never an automatic change.',
        wwbd: 'No passage settles whether work already built for a requirement the spec has since dropped comes out of the PR.' } });
      said.push(`${removed.join(', ')} removed: a question to Alex decides it, so leave that code as it is until he answers${added.length || changed.length ? ' (the fixes round for the rest waits on that answer too)' : ''}`);
    }
    cmds.push({ kind: 'message', payload: { to: w.stream || w.owner, work: w.id, about: { specDelta: [...added.map(id => keyOf(id, 'added')), ...changed.map(id => keyOf(id, 'changed')), ...removed.map(id => keyOf(id, 'removed'))] },
      text: `${PREFIX} ${w.id}: the spec changed during ${a.id} (${where}). ${a.id}'s brief stands; ${said.join('; ')}.` } });
    out.push(...cmds);
  }
  return out;
}

/** A project task's dispatch note: the plan and test plan to build to, and the requirements its job is pinned against. */
export function projectNote(p, leaf, r) {
  const base = `Project ${p.slug}: build to projects/${p.slug}/factory/implementation-plan.md${leaf.testPlanPath ? ` and test against ${leaf.testPlanPath}` : ''} (project-planning origin/main); put both paths in the brief.`;
  if (r?.status !== 'resolved') return `${base} Spec: ${r?.status || 'unknown'}${r?.reason ? ` (${r.reason})` : ''}: build from the task and ask your supervisor before guessing at requirements.`;
  const ids = Object.entries(r.reqs || {}), live = ids.filter(([, x]) => !x.removed).map(([id]) => id), gone = ids.filter(([, x]) => x.removed).map(([id]) => id);
  return `${base} Requirements: ${live.join(', ') || 'none named by the test plan'} (projects/${p.slug}/spec.md at ${String(r.commit).slice(0, 7)}).${gone.length ? ` ${gone.join(', ')} ${gone.length > 1 ? 'were' : 'was'} removed from the spec: don't build ${gone.length > 1 ? 'them' : 'it'}.` : ''}`;
}
