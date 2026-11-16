// project-planning reads (Alex, 11-16): every project folder on origin/main of the local clone, read with git show so the
// working tree Alex uses is never touched. A failed fetch reads the last origin/main it has.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseReadme, parseSpec, parseDecisions } from '../core/spec.mjs';

const exec = promisify(execFile);
export const PLANNING_DIR = join(homedir(), 'Code/repos/project-planning');

export async function readPlanning(dir = PLANNING_DIR, run = exec) {
  const git = async (...args) => (await run('git', ['-C', dir, ...args], { timeout: 60000, maxBuffer: 1 << 24 })).stdout;
  await git('fetch', '-q', 'origin', 'main').catch(() => {});
  const show = path => git('show', `origin/main:${path}`).catch(() => '');
  const slugs = (await git('ls-tree', '--name-only', 'origin/main', 'projects/')).split('\n').filter(Boolean).map(p => p.replace(/^projects\//, ''));
  return Promise.all(slugs.map(async slug => {
    const [readme, spec, decisions, plans] = await Promise.all(['README.md', 'spec.md', 'decisions.md'].map(f => show(`projects/${slug}/${f}`))
      .concat(git('ls-tree', '--name-only', 'origin/main', `projects/${slug}/test-plans/`).catch(() => '')));
    const open = parseDecisions(decisions).filter(d => d.status === 'open'), files = plans.split('\n').filter(f => /\/\d+-[^/]*\.md$/.test(f));
    // Phase C: the factory's own folder; its plan on main is what lets the project's tasks start.
    const [factoryPlan, factoryLog] = await Promise.all(['implementation-plan.md', 'decisions.md'].map(f => show(`projects/${slug}/factory/${f}`)));
    // Each test plan's REQs: what a decision must mention to hold that task (projects phase B).
    const testPlanReqs = Object.fromEntries(await Promise.all(files.map(async f => [f.split('/').pop().match(/^(\d+)-/)[1], [...new Set((await show(f)).match(/REQ-\d+/g) || [])]])));
    return { slug, readme: parseReadme(readme), reqs: Object.keys(parseSpec(spec).reqs).length, openDecisions: open.length, decisions: open.map(({ id, title, text }) => ({ id, title, text })),
      testPlans: Object.keys(testPlanReqs), testPlanReqs, testPlanFiles: Object.fromEntries(files.map(f => [f.split('/').pop().match(/^(\d+)-/)[1], f])),
      factoryPlan: !!factoryPlan.trim(), factoryDecisions: parseDecisions(factoryLog).filter(d => d.status === 'open').map(({ id, title, text }) => ({ id, title, text })) };
  }));
}
