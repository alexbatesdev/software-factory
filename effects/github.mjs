// GitHub writes and the reads that confirm them. Writes: `gh pr ready`, and resolving a review thread Alex resolved
// on the dashboard. Never merge, never request reviewers.
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
  /** A review thread's last five comments, oldest first. */
  threadComments: async id => {
    const { stdout } = await exec('gh', ['api', 'graphql', '-f', 'query=query($id:ID!){node(id:$id){... on PullRequestReviewThread{comments(last:5){nodes{author{login} body createdAt url}}}}}', '-f', `id=${id}`], { timeout: 20000 });
    return (JSON.parse(stdout).data?.node?.comments?.nodes || []).map(c => ({ by: c.author?.login || 'ghost', at: c.createdAt, body: c.body, url: c.url }));
  },
  resolveThread: async id => { await exec('gh', ['api', 'graphql', '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', '-f', `id=${id}`], { timeout: 20000 }); },
  /** Submitted reviews on a PR; a pending draft has no submitted time. */
  reviews: async url => {
    const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
    const { stdout } = await exec('gh', ['api', '--paginate', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/reviews`, '--jq', '.[] | {login: .user.login, state, at: .submitted_at, url: .html_url}'], { timeout: 20000, maxBuffer: 1 << 22 });
    return stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  },
};

// W-426: what re-requesting a reviewer needs from a PR, and the request itself (the board's own process, gh as Alex,
// under his 11-11 authorization; never a seat). Bots are marked so the planner skips them.
const BOT = /\[bot\]$|-bot$|^chatgpt-codex-connector$/;
export async function reviewState(url) {
  const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  const q = `query{repository(owner:"${m[1]}",name:"${m[2]}"){pullRequest(number:${m[3]}){author{login} state headRefOid isDraft reviews(last:50){nodes{author{login __typename} state submittedAt commit{oid}}} reviewThreads(first:100){nodes{isResolved comments(first:1){nodes{author{login}}}}} reviewRequests(first:20){nodes{requestedReviewer{... on User{login}}}}}}}`;
  const p = JSON.parse((await exec('gh', ['api', 'graphql', '-f', `query=${q}`], { timeout: 30000 })).stdout).data?.repository?.pullRequest;
  if (!p) return null;
  return { url, author: p.author?.login, open: p.state === 'OPEN', head: p.headRefOid, isDraft: p.isDraft,
    reviews: p.reviews.nodes.filter(r => r.submittedAt && r.author).map(r => ({ by: r.author.login, state: r.state, at: r.submittedAt, commit: r.commit?.oid, bot: r.author.__typename === 'Bot' || BOT.test(r.author.login) })),
    threads: p.reviewThreads.nodes.map(t => ({ by: t.comments.nodes[0]?.author?.login, resolved: t.isResolved })),
    requested: p.reviewRequests.nodes.map(r => r.requestedReviewer?.login).filter(Boolean) };
}
export async function requestReview(url, login) {
  const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
  await exec('gh', ['api', '-X', 'POST', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/requested_reviewers`, '-f', `reviewers[]=${login}`], { timeout: 30000 });
  return (await reviewState(url))?.requested.includes(login) || false;
}
