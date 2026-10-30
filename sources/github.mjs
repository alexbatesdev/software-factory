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
