// Projects (Alex, 11-16; ~/Code/plans/software-factory-v2/projects-design.md): a planning-repo project joined to its
// Teamwork tree. Each leaf task is one PR (D-013); progress is finished leaves over all leaves. Pure, read-only.
import { BUILDING, REVIEWING } from './work.mjs';

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
export function buildProjects({ planning, trees, works, prs }) {
  const byTask = new Map(), byPr = new Map();
  for (const w of Object.values(works)) { const t = taskOf(w); if (t && !byTask.has(t)) byTask.set(t, w); if (w.links?.pr) byPr.set(w.links.pr, w); }
  const open = [...prs.values()], byBranch = new Map(open.map(p => [p.branch, p])), used = new Set();
  const prView = p => p && { url: p.url, number: p.number, title: p.title, draft: !!p.isDraft, stackedOn: byBranch.get(p.base)?.number ?? null };
  const projects = planning.map(pl => {
    const root = pl.readme.teamworkTask, tree = trees[root];
    const kids = new Map(); for (const n of tree || []) kids.set(n.parent, [...(kids.get(n.parent) || []), n]);
    const leaves = [];
    const walk = (id, path) => { for (const n of kids.get(id) || []) {
      if (kids.has(n.id)) { walk(n.id, [...path, n.name]); continue; }
      const pr = open.find(p => new RegExp(`tw-${n.id}(?!\\d)`).test(p.branch)) || open.find(p => p.url === byTask.get(n.id)?.links?.pr);
      const w = byTask.get(n.id) || (pr && byPr.get(pr.url)) || null;
      if (pr) used.add(pr.url);
      leaves.push({ task: n.id, name: n.name, path: [...path, n.name].join(' / '), state: n.status === 'completed' ? 'done' : w ? stateOf(w) : pr ? 'PR open' : 'not started',
        work: w?.id || null, pr: prView(pr), testPlan: (pl.testPlans || []).includes(n.id), gate: leafGate(pl, n.id) });
    } };
    if (tree) walk(root, []);
    return { slug: pl.slug, title: pl.readme.title, stage: pl.readme.stage, status: pl.readme.status, owner: pl.readme.owner, teamworkTask: root,
      reqs: pl.reqs, openDecisions: pl.openDecisions, decisions: (pl.decisions || []).map(d => ({ id: d.id, title: d.title })), treeRead: !!tree, factoryPlan: !!pl.factoryPlan,
      developers: [...new Set((tree || []).filter(n => !kids.has(n.id)).flatMap(n => n.assignees || []))], leaves, progress: { done: leaves.filter(l => l.state === 'done').length, total: leaves.length } };
  });
  return { projects, loose: open.filter(p => !used.has(p.url)).map(prView) };
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
      source: { type: 'agent', by: 'board (projects)', key: keyOf(p) } }));
}

/** The planning job's brief: the record's objective, so the supervisor briefs from it and nothing Built-specific lives in this repo. */
export function triageObjective(p, { questionsTo = 'alex' } = {}) {
  const dir = `projects/${p.slug}`, missing = p.leaves.filter(l => !l.testPlan);
  const route = questionsTo === 'owner' ? `put needs: ${p.owner || 'the README Owner'} on the entry, and list them in the PR body for Alex to forward`
    : questionsTo === 'developers' ? `put needs: ${p.developers.join(', ') || "the tasks' assignees"} on the entry, and list them in the PR body for Alex to forward`
    : 'have your supervisor file each one as an ask on this record (distinct, one decision each) and put its TB-n in the entry\'s refs';
  return [
    `Plan the project ${p.title || p.slug} (${dir} in builtforteams/project-planning) so its tasks can be built without raising anything to Alex. Alex merges the result; nothing here is final until he does.`,
    `Repo and branch: project-planning, branch alex/factory/${p.slug}-plan from origin/main. Never commit or push to main, even though the repo's own skills do: one draft PR, ordinary pushes only, and Alex merges it.`,
    `Read first, in full: ${dir}/README.md, intent.md, spec.md, decisions.md, discussion.md, plan.md and test-plans/ if present, and templates/decisions.md. The Teamwork tree (top task ${p.teamworkTask}) has ${p.leaves.length} tasks: ${p.leaves.map(l => `${l.task} ${l.name}`).join('; ')}.`,
    `Write ${dir}/factory/implementation-plan.md: for each task, the approach, the code areas it touches, the order and which PRs stack, risks, and every edge case and ambiguity with how it is settled (cite REQ IDs and D-/FD- entries). Workers follow it, so write it for someone with the repo and none of this context.`,
    `Write ${dir}/factory/decisions.md in templates/decisions.md's format, numbered FD-001 upward (never reuse the team's D- numbers): one entry per ambiguity you found. Settle what the spec, the team's decisions or the codebase answers (say which, with the source). What only a person can answer stays status: open; for each, ${route}.`,
    missing.length ? `Draft the missing test plans in the same PR, following project-planning's built-test-plans skill (plugins/built-intent/skills/built-test-plans) for format and rules, but skipping its commit to main: ${missing.map(l => `${l.task} ${l.name}`).join('; ')}.` : 'Every task already has a test plan; bring any that disagree with the spec back in line.',
    'Review before you report: a fresh subagent reads the plan, the decision log and the test plans against the spec and the team decisions for gaps, contradictions and unanswered edge cases. Fix what it finds. The built-rails review lenses do not apply to this repo.',
    'Stop when the draft PR is open and pushed: report the PR, the pushed head SHA, and the FD entries left open.',
  ].join('\n\n');
}
