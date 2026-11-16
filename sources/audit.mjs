// On-demand Brakeman (Alex 11-16): the built-rails "Audit Ruby code and dependencies" check is Brakeman (CI's
// bundler-audit step always exits 0). Run on the host, never in a sandbox: a detached worktree of the repo's local
// checkout at the commit, git hooks off, CI's own Brakeman flags, then the worktree is removed. Results are cached per
// commit. Alex's standing approval: install the pinned brakeman gem whenever it is missing (e.g. after a Ruby bump).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
export const AUDIT_CHECK = 'Audit Ruby code and dependencies';
const FLAGS = ['-c', 'config/brakeman.yml', '-i', 'config/brakeman.ignore', '--add-checks-path', 'brakeman_extensions', '-q', '--no-pager', '-f', 'json'];

/** Brakeman's JSON report → [{fingerprint, type, confidence, file, line, message}]. */
export const parseBrakeman = text => (JSON.parse(text).warnings || []).map(w => ({ fingerprint: w.fingerprint, type: w.warning_type, confidence: w.confidence, file: w.file, line: w.line, message: w.message }));

/**
 * @param checkout the repo's local clone; sha a commit (fetched from origin if missing)
 * @returns {sha, warnings, version, durationMs, at}, cached in cacheDir/<sha>.json
 */
export async function runBrakeman({ checkout, sha, cacheDir, log = () => {} }) {
  const cached = join(cacheDir, `${sha}.json`);
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const git = (...a) => run('git', ['-C', checkout, '-c', 'core.hooksPath=/dev/null', ...a], { timeout: 120000, maxBuffer: 1 << 24 });
  await git('cat-file', '-e', `${sha}^{commit}`).catch(() => git('fetch', '-q', 'origin', sha));
  const wt = join(homedir(), 'Code/repos/Worktrees', `factory-audit-${sha.slice(0, 7)}`), t0 = Date.now();
  if (existsSync(wt)) await git('worktree', 'remove', wt).catch(() => {});
  await git('worktree', 'add', '-q', '--detach', wt, sha);
  try {
    const version = readFileSync(join(wt, 'Gemfile.lock'), 'utf8').match(/^ {4}brakeman \(([\d.]+)\)/m)?.[1];
    if (!version) throw new Error(`no brakeman in ${sha.slice(0, 7)}'s Gemfile.lock`);
    const mise = (...a) => run('mise', ['exec', '--', ...a], { cwd: wt, timeout: 900000, maxBuffer: 1 << 26 });
    if (!(await mise('brakeman', `_${version}_`, '--version').then(() => true, () => false))) { log(`installing brakeman ${version}`); await mise('gem', 'install', 'brakeman', '-v', version, '--no-document'); }
    const out = join(wt, 'tmp', 'factory-brakeman.json');
    mkdirSync(join(wt, 'tmp'), { recursive: true });
    // Exit 3 means warnings were found; the report is still written.
    await mise('brakeman', `_${version}_`, ...FLAGS, '-o', out).catch(e => { if (e.code !== 3) throw e; });
    const result = { sha, warnings: parseBrakeman(readFileSync(out, 'utf8')), version, durationMs: Date.now() - t0, at: new Date().toISOString() };
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    // The report sits under tmp/ (git-ignored), so the worktree is clean and goes without --force.
    await git('worktree', 'remove', wt).catch(e => log(`worktree ${wt} left: ${e.message}`));
  }
}
