// project-planning reads (Alex, 11-16): every project folder on origin/main of the local clone, read with git show so the
// working tree Alex uses is never touched. A failed fetch reads the last origin/main it has, and says which commit that is.
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
  // One commit for the whole read, so a pinned spec names exactly what was read (phase 2).
  const commit = (await git('rev-parse', 'origin/main')).trim();
  const slugs = (await git('ls-tree', '--name-only', commit, 'projects/')).split('\n').filter(Boolean).map(p => p.replace(/^projects\//, ''));
  return Promise.all(slugs.map(async slug => {
    const dir = `projects/${slug}/`, blobs = new Map((await git('ls-tree', '-r', commit, dir)).split('\n').filter(Boolean).map(l => l.split('\t')).map(([meta, path]) => [path.slice(dir.length), meta.split(' ')[2]]));
    // A file that isn't there reads as empty; one that is there and fails to read is an error, never an empty file.
    const show = f => blobs.has(f) ? git('show', `${commit}:${dir}${f}`) : Promise.resolve('');
    const [readme, specText, decisions, factoryPlan, factoryLog] = await Promise.all(['README.md', 'spec.md', 'decisions.md', 'factory/implementation-plan.md', 'factory/decisions.md'].map(show));
    const open = parseDecisions(decisions).filter(d => d.status === 'open'), files = [...blobs.keys()].filter(f => /^test-plans\/\d+-[^/]*\.md$/.test(f));
    // Each test plan's REQs: what a decision must mention to hold that task (projects phase B).
    const testPlanReqs = Object.fromEntries(await Promise.all(files.map(async f => [f.split('/').pop().match(/^(\d+)-/)[1], [...new Set((await show(f)).match(/REQ-\d+/g) || [])]])));
    const spec = parseSpec(specText);
    return { slug, commit, specBlob: blobs.get('spec.md') || null, spec: { teamworkTask: spec.teamworkTask, reqs: spec.reqs },
      readme: parseReadme(readme), reqs: Object.values(spec.reqs).filter(r => !r.removed).length, openDecisions: open.length, decisions: open.map(({ id, title, text }) => ({ id, title, text })),
      testPlans: Object.keys(testPlanReqs), testPlanReqs, testPlanFiles: Object.fromEntries(files.map(f => [f.split('/').pop().match(/^(\d+)-/)[1], dir + f])),
      factoryPlan: !!factoryPlan.trim(), factoryDecisions: parseDecisions(factoryLog).filter(d => d.status === 'open').map(({ id, title, text }) => ({ id, title, text })) };
  }));
}
