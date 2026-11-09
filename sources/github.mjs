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
/** GitHub's compare status of head against base: ahead or identical means head descends from base. */
export async function readCompare(owner, repo, base, head, run = exec) {
  return (await run('gh', ['api', `repos/${owner}/${repo}/compare/${base}...${head}`, '--jq', '.status'], { timeout: 30000 })).stdout.trim();
}

export async function readPrs(urls, run = exec) {
  const out = [];
  for (let i = 0; i < urls.length; i += 40) {
    const chunk = urls.slice(i, i + 40).map(u => [u, String(u).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/)]).filter(([, m]) => m);
    if (!chunk.length) continue;
    const q = `query{${chunk.map(([, m], j) => `p${j}: repository(owner:"${m[1]}",name:"${m[2]}"){pullRequest(number:${m[3]}){url state isDraft headRefOid mergedAt reviewDecision mergeStateStatus baseRefName reviewThreads(first:100){nodes{isResolved}} commits(last:100){nodes{commit{oid}}} latestOpinionatedReviews(first:20){nodes{state author{login} commit{oid}}}}}`).join(' ')}}`;
    const { data } = JSON.parse((await run('gh', ['api', 'graphql', '-f', `query=${q}`], { timeout: 30000, maxBuffer: 1 << 23 })).stdout);
    chunk.forEach(([url], j) => { const p = data?.[`p${j}`]?.pullRequest; if (p) out.push({ url, state: p.state, isDraft: p.isDraft, head: p.headRefOid, mergedAt: p.mergedAt, reviewDecision: p.reviewDecision || null, mergeState: p.mergeStateStatus || null, base: p.baseRefName || null,
      unresolvedThreads: p.reviewThreads ? p.reviewThreads.nodes.filter(t => !t.isResolved).length : null,
      approvals: (p.latestOpinionatedReviews?.nodes || []).filter(r => r.state === 'APPROVED').map(r => ({ by: r.author?.login, commit: r.commit?.oid || null })),
      recentCommits: (p.commits?.nodes || []).map(c => c.commit.oid),
      approvedBy: (p.latestOpinionatedReviews?.nodes || []).filter(r => r.state === 'APPROVED').map(r => r.author?.login).filter(Boolean) }); });
  }
  return out;
}

const RED = ['FAILURE', 'ERROR', 'TIMED_OUT', 'STARTUP_FAILURE'];
/** Merge and CI state of each repo:num spec at its head, 30 per GraphQL call. `conflict` is only true once GitHub has computed it. */
/** @param me Alex's login: his own reviews and threads are not feedback to act on. */
// A bot (a GitHub app, or a 🤖-signed account like Hermes) counts only when it reports a finding.
const isBot = c => c.author?.__typename === 'Bot' || c.body.trimStart().startsWith('🤖');
const isFinding = body => body.includes('codex-code-review-finding') || /hermes-verdict \w+ \([^)]*found=[1-9]/.test(body);
const ISSUE = 'id number url state createdAt author{login __typename} comments(last:1){nodes{author{login}}}';
export async function readPrHealth(specs, owner, run = exec, me = null, since = '') {
  const out = new Map();
  for (let i = 0; i < specs.length; i += 30) {
    const chunk = specs.slice(i, i + 30).map(x => x.split(':'));
    const q = `query{${chunk.map(([repo, n], j) => `p${j}: repository(owner:"${owner}",name:"${repo}"){pullRequest(number:${n}){baseRefName mergeable headRefOid reviews(last:20,states:[CHANGES_REQUESTED]){nodes{id url author{login} commit{oid}}} comments(last:30){nodes{id url createdAt body author{login __typename}}} summaries: reviews(last:20,states:[COMMENTED]){nodes{id url submittedAt body author{login __typename}}} refs: timelineItems(last:50,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{... on CrossReferencedEvent{source{... on Issue{${ISSUE} subIssues(first:50){nodes{${ISSUE}}}}}}}} reviewThreads(first:100){nodes{id isResolved comments(first:1){nodes{url author{login}}} last:comments(last:1){nodes{author{login}}}}} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:50){nodes{... on CheckRun{name conclusion} ... on StatusContext{context state}}}}}}}}}`).join(' ')}}`;
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
      // Conversation comments and review summaries can't be resolved: anything another person (or a codex finding) said after
      // Alex last spoke counts. `since` keeps the first read from reopening records on old comments.
      const lastMine = [since, ...(p.comments?.nodes || []).filter(c => by(c) === me).map(c => c.createdAt)].sort().at(-1) || '';
      const said = [...(p.comments?.nodes || []), ...(p.summaries?.nodes || []).map(r => ({ ...r, createdAt: r.submittedAt }))]
        .filter(c => by(c) !== me && c.body?.trim() && (!isBot(c) || isFinding(c.body)) && c.createdAt > lastMine)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(c => ({ id: c.id, by: by(c), url: c.url }));
      // QA files findings as sub-issues of an issue that references the PR (#8244): each open one is feedback until QA closes it.
      const issues = [...new Map((p.refs?.nodes || []).map(r => r.source).filter(x => x?.id).flatMap(x => x.subIssues?.nodes?.length ? x.subIssues.nodes : [x])
        .filter(x => x.state === 'OPEN' && by(x) !== me && x.author?.__typename !== 'Bot' && by(x.comments?.nodes?.[0]) !== me && x.createdAt > since).map(x => [x.id, { id: x.id, by: by(x), url: x.url }])).values()];
      out.set(`${repo}:${n}`, { head: p.headRefOid, base: p.baseRefName, conflict: p.mergeable === 'CONFLICTING', failing, changesRequested, threads, comments: [...said, ...issues] });
    });
  }
  return out;
}

/** repo → the oid of main's latest commit when its checks passed, else null (red, pending or unknown). */
export async function readMainGreen(repos, owner, run = exec) {
  if (!repos.length) return new Map();
  const q = `query{${repos.map((r, i) => `r${i}: repository(owner:"${owner}",name:"${r}"){ref(qualifiedName:"refs/heads/main"){target{... on Commit{oid statusCheckRollup{state}}}}}`).join(' ')}}`;
  const { data } = JSON.parse((await run('gh', ['api', 'graphql', '-f', `query=${q}`], { timeout: 30000 })).stdout);
  return new Map(repos.map((r, i) => { const t = data?.[`r${i}`]?.ref?.target; return [r, t?.statusCheckRollup?.state === 'SUCCESS' ? t.oid : null]; }));
}
