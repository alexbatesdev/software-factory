// GitHub writes and the reads that confirm them. Writes: `gh pr ready` only. Never merge, never request reviewers.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPrs } from '../sources/github.mjs';

const exec = promisify(execFile);

export const gh = {
  view: async url => (await readPrs([url]))[0] || null,
  ready: async url => { await exec('gh', ['pr', 'ready', url], { timeout: 30000 }); },
  /** Submitted reviews on a PR; a pending draft has no submitted time. */
  reviews: async url => {
    const m = String(url).match(/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/);
    const { stdout } = await exec('gh', ['api', '--paginate', `repos/${m[1]}/${m[2]}/pulls/${m[3]}/reviews`, '--jq', '.[] | {login: .user.login, state, at: .submitted_at, url: .html_url}'], { timeout: 20000, maxBuffer: 1 << 22 });
    return stdout.split('\n').filter(Boolean).map(l => JSON.parse(l));
  },
};
