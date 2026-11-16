// CircleCI reads for W-501 (GET only): a branch's latest run of each job at a commit, and the tests that failed in it.
// Needs CIRCLE_TOKEN in the server's environment; without it nothing is read and check names decide as before.
const API = 'https://circleci.com/api/v2';

async function circle(path, f = fetch) {
  const r = await f(API + path, { headers: { 'Circle-Token': process.env.CIRCLE_TOKEN ?? '' } });
  if (!r.ok) throw new Error(`CircleCI ${r.status} for ${path.split('?')[0]}`);
  return r.json();
}
async function allPages(path, f, max = 20) {
  const out = [];
  for (let token = null, i = 0; i < max; i++) {
    const page = await circle(`${path}${token ? `${path.includes('?') ? '&' : '?'}page-token=${encodeURIComponent(token)}` : ''}`, f);
    out.push(...(page.items || []));
    if (!(token = page.next_page_token)) break;
  }
  return out;
}

export const circleReady = () => !!process.env.CIRCLE_TOKEN;

/**
 * Each finished job of the newest pipeline on `branch` (at `sha` when given) whose workflows are done:
 * Map("ci/circleci: <job>" → {status, tests}), tests being the failed test ids, or null when the job ran none.
 */
export async function readJobFailures(slug, branch, sha = null, f = fetch) {
  const pipelines = (await circle(`/project/${slug}/pipeline?branch=${encodeURIComponent(branch)}`, f)).items || [];
  for (const p of pipelines.filter(p => !sha || p.vcs?.revision === sha).slice(0, 5)) {
    const workflows = (await circle(`/pipeline/${p.id}/workflow`, f)).items || [];
    if (!workflows.length || workflows.some(w => ['running', 'on_hold', 'not_run'].includes(w.status))) continue;
    const out = new Map();
    for (const w of workflows) for (const j of await allPages(`/workflow/${w.id}/job`, f)) {
      if (j.status !== 'failed' || !j.job_number) { out.set(`ci/circleci: ${j.name}`, { status: j.status, tests: [] }); continue; }
      const tests = await allPages(`/project/${slug}/${j.job_number}/tests`, f);
      out.set(`ci/circleci: ${j.name}`, { status: j.status, tests: tests.length ? tests.filter(t => t.result === 'failure').map(t => `${t.file || t.classname}::${t.name}`) : null });
    }
    return out;
  }
  return null;
}
