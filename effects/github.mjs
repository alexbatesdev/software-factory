// GitHub writes and the reads that confirm them. Writes: `gh pr ready`, resolving a review thread Alex resolved on the
// dashboard, and GitHub auto-merge on and off for small, quick fixes (W-564; enabling auto-merge is not a merge). Never
// merge, never request reviewers.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPrs } from '../sources/github.mjs';

const exec = promisify(execFile);

export const gh = {
  view: async url => (await readPrs([url]))[0] || null,
  ready: async url => { await exec('gh', ['pr', 'ready', url], { timeout: 30000 }); },
  /** A review thread's PR and resolved state, or null when the id isn't a review thread. */
  thread: async id => {
    // gh exits 1 on an unknown id but still prints the {node: null} answer.
    const { stdout } = await exec('gh', ['api', 'graphql', '-f', 'query=query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved pullRequest{url} first:comments(first:1){nodes{author{login}}} last:comments(last:1){nodes{author{login}}}}}}', '-f', `id=${id}`], { timeout: 20000 })
      .catch(e => { if (/NOT_FOUND/.test(e.stdout || '')) return { stdout: e.stdout }; throw e; });
    const n = JSON.parse(stdout).data?.node;
    return n?.pullRequest ? { pr: n.pullRequest.url, isResolved: n.isResolved, first: n.first?.nodes?.[0]?.author?.login || null, last: n.last?.nodes?.[0]?.author?.login || null } : null;
  },
  /** What the resolve checks read from a review thread (Alex, 11-20): its file, its asker, and its last comments with 👍s. */
  threadFacts: async id => {
    const q = 'query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved path first:comments(first:1){nodes{author{login}}} comments(last:20){nodes{author{login} createdAt reactions(content:THUMBS_UP,first:20){nodes{user{login}}}}}}}}';
    const n = JSON.parse((await exec('gh', ['api', 'graphql', '-f', `query=${q}`, '-f', `id=${id}`], { timeout: 20000 })).stdout).data?.node;
    return n ? { isResolved: n.isResolved, path: n.path || null, first: n.first?.nodes?.[0]?.author?.login || null,
      comments: (n.comments?.nodes || []).map(c => ({ by: c.author?.login || 'ghost', at: c.createdAt, thumbsBy: (c.reactions?.nodes || []).map(r => r.user?.login).filter(Boolean) })) } : null;
  },
  /** Whether a commit is on the PR, the files it changes, and its place in the PR's commit list. */
  fixFacts: async (url, sha) => {
    const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
    const shas = (await exec('gh', ['api', '--paginate', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/commits`, '--jq', '.[].sha'], { timeout: 30000, maxBuffer: 1 << 22 })).stdout.split('\n').filter(Boolean);
    const index = shas.findIndex(x => x.startsWith(sha));
    if (index < 0) return { onPr: false, files: [], index: null, shas };
    const files = JSON.parse((await exec('gh', ['api', `repos/${m[1]}/${m[2]}/commits/${shas[index]}`, '--jq', '[.files[].filename]'], { timeout: 30000, maxBuffer: 1 << 22 })).stdout);
    return { onPr: true, files, index, shas };
  },
  /** A review thread's last five comments, oldest first. */
  threadComments: async id => {
    const { stdout } = await exec('gh', ['api', 'graphql', '-f', 'query=query($id:ID!){node(id:$id){... on PullRequestReviewThread{comments(last:5){nodes{author{login} body createdAt url}}}}}', '-f', `id=${id}`], { timeout: 20000 });
    return (JSON.parse(stdout).data?.node?.comments?.nodes || []).map(c => ({ by: c.author?.login || 'ghost', at: c.createdAt, body: c.body, url: c.url }));
  },
  /**
   * W-564: GitHub merges the PR (merge commit) once its own ruleset passes; the factory only turns this on or off.
   * The API mutation, never `gh pr merge --auto`: on a PR already mergeable that merges it outright (#8906, 11-18).
   */
  autoMerge: async (url, on, run = exec) => {
    const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/) || (() => { throw new Error(`${url} is not a PR`); })();
    const id = (await run('gh', ['api', `repos/${m[1]}/${m[2]}/pulls/${m[3]}`, '--jq', '.node_id'], { timeout: 20000 })).stdout.trim().replace(/^"|"$/g, '');
    const mutation = on ? 'mutation($id:ID!){enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:MERGE}){clientMutationId}}'
      : 'mutation($id:ID!){disablePullRequestAutoMerge(input:{pullRequestId:$id}){clientMutationId}}';
    await run('gh', ['api', 'graphql', '-f', `query=${mutation}`, '-f', `id=${id}`], { timeout: 30000 });
  },
  resolveThread: async id => { await exec('gh', ['api', 'graphql', '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', '-f', `id=${id}`], { timeout: 20000 }); },
  /** Submitted reviews on a PR; a pending draft has no submitted time. */
  reviews: async url => {
    const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
    const { stdout } = await exec('gh', ['api', '--paginate', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/reviews`, '--jq', '.[] | {login: .user.login, state, at: .submitted_at, url: .html_url, commit: .commit_id}'], { timeout: 20000, maxBuffer: 1 << 22 });
    return stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  },
};

// W-426: what re-requesting a reviewer needs from a PR, and the request itself (the board's own process, gh as Alex,
// under his 11-11 authorization; never a seat). Bots are marked so the planner skips them.
const BOT = /\[bot\]$|-bot$|^chatgpt-codex-connector$/;
export async function reviewState(url) {
  const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  const q = `query{repository(owner:"${m[1]}",name:"${m[2]}"){pullRequest(number:${m[3]}){author{login} state headRefOid isDraft reviews(last:50){nodes{author{login __typename} state submittedAt body commit{oid}}} reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login}}} last: comments(last:1){nodes{author{login}}}}} comments(last:100){nodes{author{login} createdAt}} reviewRequests(first:20){nodes{requestedReviewer{... on User{login}}}}}}}`;
  const p = JSON.parse((await exec('gh', ['api', 'graphql', '-f', `query=${q}`], { timeout: 30000 })).stdout).data?.repository?.pullRequest;
  if (!p) return null;
  return { url, author: p.author?.login, open: p.state === 'OPEN', head: p.headRefOid, isDraft: p.isDraft,
    reviews: p.reviews.nodes.filter(r => r.submittedAt && r.author).map(r => ({ by: r.author.login, state: r.state, at: r.submittedAt, body: r.body || '', commit: r.commit?.oid, bot: r.author.__typename === 'Bot' || BOT.test(r.author.login) })),
    threads: p.reviewThreads.nodes.map(t => ({ by: t.comments.nodes[0]?.author?.login, resolved: t.isResolved, lastBy: t.last?.nodes?.[0]?.author?.login || null })),
    comments: (p.comments?.nodes || []).filter(c => c.author).map(c => ({ by: c.author.login, at: c.createdAt })),
    requested: p.reviewRequests.nodes.map(r => r.requestedReviewer?.login).filter(Boolean) };
}
export async function requestReview(url, login) {
  const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  await exec('gh', ['api', '-X', 'POST', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/requested_reviewers`, '-f', `reviewers[]=${login}`], { timeout: 30000 });
  return (await reviewState(url))?.requested.includes(login) || false;
}
