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
    const { stdout } = await exec('gh', ['api', 'graphql', '-f', 'query=query($id:ID!){node(id:$id){... on PullRequestReviewThread{isResolved pullRequest{url}}}}', '-f', `id=${id}`], { timeout: 20000 });
    const n = JSON.parse(stdout).data?.node;
    return n?.pullRequest ? { pr: n.pullRequest.url, isResolved: n.isResolved } : null;
  },
  resolveThread: async id => { await exec('gh', ['api', 'graphql', '-f', 'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}', '-f', `id=${id}`], { timeout: 20000 }); },
  /** Submitted reviews on a PR; a pending draft has no submitted time. */
  reviews: async url => {
    const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
    const { stdout } = await exec('gh', ['api', '--paginate', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/reviews`, '--jq', '.[] | {login: .user.login, state, at: .submitted_at, url: .html_url}'], { timeout: 20000, maxBuffer: 1 << 22 });
    return stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  },
};
