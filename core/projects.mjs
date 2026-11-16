// Projects (Alex, 11-16; ~/Code/plans/software-factory-v2/projects-design.md): a planning-repo project joined to its
// Teamwork tree. Each leaf task is one PR (D-013); progress is finished leaves over all leaves. Pure, read-only.
import { BUILDING, REVIEWING } from './work.mjs';

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
        work: w?.id || null, pr: prView(pr), testPlan: (pl.testPlans || []).includes(n.id) });
    } };
    if (tree) walk(root, []);
    return { slug: pl.slug, title: pl.readme.title, stage: pl.readme.stage, status: pl.readme.status, owner: pl.readme.owner, teamworkTask: root,
      reqs: pl.reqs, openDecisions: pl.openDecisions, treeRead: !!tree, leaves, progress: { done: leaves.filter(l => l.state === 'done').length, total: leaves.length } };
  });
  return { projects, loose: open.filter(p => !used.has(p.url)).map(prView) };
}
