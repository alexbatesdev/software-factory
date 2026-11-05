// GitHub reads for the factory. Reads only: marking ready, merging and review checks are effects, not sources.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
// One script owns the threads query, shared with the triage skill; it lives outside this repo.
const THREADS_SH = join(homedir(), '.claude/skills/triage/threads.sh');

/** threads.sh lines for Alex's open PRs and for PRs that tracked records link. `own` is the set of Alex's open PR specs. */
export async function readPrLines({ owner, tracked = [] }, run = exec) {
  const { stdout } = await run('gh', ['search', 'prs', '--author=@me', '--state=open', `--owner=${owner}`,
    '--json', 'repository,number', '--jq', '.[] | "\\(.repository.name):\\(.number)"'], { maxBuffer: 1 << 22 });
  const own = stdout.split('\n').filter(Boolean);
  const extra = tracked.filter(x => !own.includes(x));
  const lines = [];
  if (own.length) lines.push(...(await run(THREADS_SH, own, { maxBuffer: 1 << 25 })).stdout.split('\n').filter(Boolean));
  // An unreachable linked PR stays unverified rather than failing the whole read.
  if (extra.length) try { lines.push(...(await run(THREADS_SH, extra, { maxBuffer: 1 << 25 })).stdout.split('\n').filter(Boolean)); } catch {}
  return { lines, own: new Set(own) };
}

/** Fresh state of each PR URL, 40 per GraphQL call; an unreadable PR is left out. */
export async function readPrs(urls, run = exec) {
  const out = [];
  for (let i = 0; i < urls.length; i += 40) {
    const chunk = urls.slice(i, i + 40).map(u => [u, String(u).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/)]).filter(([, m]) => m);
    if (!chunk.length) continue;
    const q = `query{${chunk.map(([, m], j) => `p${j}: repository(owner:"${m[1]}",name:"${m[2]}"){pullRequest(number:${m[3]}){url state isDraft headRefOid mergedAt}}`).join(' ')}}`;
    const { data } = JSON.parse((await run('gh', ['api', 'graphql', '-f', `query=${q}`], { timeout: 30000, maxBuffer: 1 << 23 })).stdout);
    chunk.forEach(([url], j) => { const p = data?.[`p${j}`]?.pullRequest; if (p) out.push({ url, state: p.state, isDraft: p.isDraft, head: p.headRefOid, mergedAt: p.mergedAt }); });
  }
  return out;
}

const RED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE'];
/** Merge and CI state of each repo:num spec at its head, 30 per GraphQL call. `conflict` is only true once GitHub has computed it. */
/** @param me Alex's login: his own reviews and threads are not feedback to act on. */
export async function readPrHealth(specs, owner, run = exec, me = null) {
  const out = new Map();
  for (let i = 0; i < specs.length; i += 30) {
    const chunk = specs.slice(i, i + 30).map(x => x.split(':'));
    const q = `query{${chunk.map(([repo, n], j) => `p${j}: repository(owner:"${owner}",name:"${repo}"){pullRequest(number:${n}){baseRefName mergeable headRefOid reviews(last:20,states:[CHANGES_REQUESTED]){nodes{id url author{login} commit{oid}}} reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{url author{login}}} last:comments(last:1){nodes{author{login}}}}} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:50){nodes{... on CheckRun{name conclusion} ... on StatusContext{context state}}}}}}}}}`).join(' ')}}`;
    const { data } = JSON.parse((await run('gh', ['api', 'graphql', '-f', `query=${q}`], { timeout: 30000, maxBuffer: 1 << 23 })).stdout);
    chunk.forEach(([repo, n], j) => {
      const p = data?.[`p${j}`]?.pullRequest; if (!p) return;
      const roll = p.commits?.nodes?.[0]?.commit?.statusCheckRollup;
      const failing = (roll?.contexts?.nodes || []).filter(c => RED.includes(c.conclusion || c.state)).map(c => c.name || c.context);
      // Only named checks count: a cancelled bot run (Teamwork Sync) turns the rollup red without any CI failing.
      const by = x => x?.author?.login || 'ghost';
      // Feedback still to act on: a change request on the current head (a later push answered older ones), and an
      // unresolved thread whose last word isn't Alex's (workers reply from his account; only he resolves).
      const changesRequested = (p.reviews?.nodes || []).filter(r => by(r) !== me && r.commit?.oid === p.headRefOid).map(r => ({ id: r.id, by: by(r), url: r.url }));
      const threads = (p.reviewThreads?.nodes || []).filter(t => !t.isResolved && by(t.comments?.nodes?.[0]) !== me && by(t.last?.nodes?.[0]) !== me)
        .map(t => ({ id: t.id, by: by(t.comments.nodes[0]), url: t.comments.nodes[0]?.url }));
      out.set(`${repo}:${n}`, { head: p.headRefOid, base: p.baseRefName, conflict: p.mergeable === 'CONFLICTING', failing, changesRequested, threads });
    });
  }
  return out;
}
