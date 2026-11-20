import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, realpath, readdir, stat, link } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

const exec = promisify(execFile);
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 512 * 1024 * 1024;
const MAX_FILES = 100_000;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const environment = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };

async function objectBytes(directory, limit) {
  let total = 0; const pending = [directory];
  while (pending.length) {
    const folder = pending.pop(); let entries;
    try { entries = await readdir(folder, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const entry of entries) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) { try { total += (await stat(path)).size; } catch (error) { if (error.code !== 'ENOENT') throw error; } }
      if (total > limit) throw new Error('Fetched PR objects exceed the 512 MiB storage limit');
    }
  }
}
async function run(program, args, options = {}) {
  const { input, objectDirectory, objectBudget = MAX_TOTAL, ...settings } = options;
  const pending = exec(program, args, { env: environment, encoding: 'buffer', timeout: 90_000, maxBuffer: 32 * 1024 * 1024, ...settings });
  pending.child.stdin.on('error', () => {}); pending.child.stdin.end(input);
  let checking = null, budgetError = null;
  const check = () => {
    if (checking || budgetError) return;
    checking = objectBytes(objectDirectory, objectBudget).catch(error => { budgetError = error; pending.child.kill('SIGKILL'); }).finally(() => { checking = null; });
  };
  const monitor = objectDirectory ? setInterval(check, 100) : null; monitor?.unref();
  try {
    let result;
    try { result = await pending; } catch (error) { if (checking) await checking; throw budgetError || error; }
    if (objectDirectory) await objectBytes(objectDirectory, objectBudget);
    if (budgetError) throw budgetError;
    return result.stdout;
  } finally { if (monitor) clearInterval(monitor); if (checking) await checking; }
}
async function git(root, args, options) { return run('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', root, ...args], options); }
export function githubRepository(remote) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(remote.trim());
  if (!match || !match[1].split('/').every(part => part !== '.' && part !== '..')) throw new Error('Configure a GitHub origin or an explicit owner/repository for this project');
  return match[1];
}
function repositoryName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid configured GitHub repository');
  return value;
}
function relativePath(path) {
  if (!path || isAbsolute(path) || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Git snapshot contains an unsafe path');
  return path;
}
export async function githubPr(repository, number) {
  const query = '{number,title,url,baseSha:.base.sha,headSha:.head.sha,repository:.base.repo.full_name}';
  let pr;
  try { pr = JSON.parse((await run('gh', ['api', `repos/${repository}/pulls/${number}`, '--jq', query])).toString('utf8')); }
  catch { throw new Error('Could not load this GitHub PR. Check the project origin, PR number and local gh authentication.'); }
  if (pr.number !== number || pr.repository?.toLowerCase() !== repository.toLowerCase() || !SHA.test(pr.baseSha) || !SHA.test(pr.headSha)) throw new Error('GitHub returned an invalid PR revision');
  let mergeBaseSha;
  try { mergeBaseSha = (await run('gh', ['api', `repos/${repository}/compare/${pr.baseSha}...${pr.headSha}`, '--jq', '.merge_base_commit.sha'])).toString('utf8').trim(); }
  catch { throw new Error('Could not resolve the PR comparison merge-base. Retry when GitHub is available.'); }
  if (!SHA.test(mergeBaseSha)) throw new Error('GitHub returned no valid PR merge-base');
  return { number, title: String(pr.title).slice(0, 1000), url: `https://github.com/${repository}/pull/${number}`, baseSha: pr.baseSha, headSha: pr.headSha, mergeBaseSha };
}
async function entries(root, sha) {
  const output = await git(root, ['ls-tree', '-r', '-z', '-l', '--full-tree', sha]);
  const result = []; const names = new Set();
  for (const record of output.toString('utf8').split('\0').filter(Boolean)) {
    const at = record.indexOf('\t'); const [mode, type, oid, rawSize] = record.slice(0, at).trim().split(/\s+/);
    const path = relativePath(record.slice(at + 1));
    if (at < 0 || !SHA.test(oid) || path.includes('\uFFFD')) throw new Error('Unsupported Git tree entry or filename encoding');
    const normalized = path.normalize('NFC').toLowerCase();
    if (names.has(normalized)) throw new Error('PR snapshot contains names that collide on a case-insensitive filesystem');
    names.add(normalized);
    const bytes = type === 'blob' ? Number(rawSize) : 0;
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid Git blob size');
    const omitted = mode === '160000' ? 'Submodule contents are not analyzed' : !['100644', '100755'].includes(mode) ? 'Symlink contents are not followed' : bytes > MAX_FILE ? 'File exceeds the 8 MiB snapshot limit' : null;
    result.push({ path, oid, bytes, omitted });
    if (result.length > MAX_FILES) throw new Error('PR snapshot exceeds the 100,000 file limit');
  }
  return result;
}
class ByteReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.offset = 0; }
  async ready() {
    if (this.offset < this.chunk.length) return;
    const next = await this.iterator.next(); if (next.done) throw new Error('Git blob stream ended early');
    this.chunk = next.value; this.offset = 0;
  }
  async line() {
    const pieces = []; let length = 0;
    while (true) {
      await this.ready(); const end = this.chunk.indexOf(10, this.offset); const stop = end < 0 ? this.chunk.length : end;
      const piece = this.chunk.subarray(this.offset, stop); pieces.push(piece); length += piece.length; this.offset = stop + (end < 0 ? 0 : 1);
      if (length > 4096) throw new Error('Invalid Git blob header');
      if (end >= 0) return Buffer.concat(pieces, length).toString('ascii');
    }
  }
  async bytes(length) {
    const pieces = []; let remaining = length;
    while (remaining) { await this.ready(); const take = Math.min(remaining, this.chunk.length - this.offset); pieces.push(this.chunk.subarray(this.offset, this.offset + take)); this.offset += take; remaining -= take; }
    return Buffer.concat(pieces, length);
  }
}
async function materialize(repository, files, root, budget, copied, onProgress) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', repository, 'cat-file', '--batch'], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume(); let spawnError; child.once('error', error => { spawnError = error; }); child.stdin.on('error', () => {});
  const exited = new Promise(done => child.once('close', code => done(code)));
  const timer = setTimeout(() => child.kill('SIGKILL'), 120_000); timer.unref();
  const pending = new Set(); let failure;
  try {
    const reader = new ByteReader(child.stdout);
    const directories = new Map(); let completed = 0;
    const finished = () => { completed++; if (completed % 100 === 0) onProgress(completed, files.length); };
    const start = work => {
      const job = work.then(finished).catch(error => { failure ||= error; }).finally(() => pending.delete(job));
      pending.add(job);
    };
    onProgress(0, files.length);
    for (const file of files) {
      if (pending.size >= 4) await Promise.race(pending);
      if (failure) throw failure;
      if (file.omitted) { finished(); continue; }
      budget.bytes += file.bytes;
      if (budget.bytes > MAX_TOTAL) throw new Error('PR snapshots exceed the 512 MiB total limit');
      const segments = file.path.split('/'); segments.pop();
      const folder = join(root, ...segments);
      const destination = join(root, file.path), existing = copied.get(file.oid);
      let data;
      if (existing) {
        if (existing.bytes !== file.bytes) throw new Error('Git blob size did not match the pinned tree');
      } else {
        await new Promise((done, reject) => child.stdin.write(file.oid + '\n', error => error ? reject(error) : done()));
        const [oid, type, size] = (await reader.line()).split(' ');
        if (oid !== file.oid || type !== 'blob' || Number(size) !== file.bytes || file.bytes > MAX_FILE) throw new Error('Git blob did not match the pinned tree');
        data = await reader.bytes(file.bytes);
        if ((await reader.bytes(1))[0] !== 10) throw new Error('Invalid Git blob boundary');
      }
      if (failure) throw failure;
      const work = (async () => {
        if (segments.length) {
          if (!directories.has(folder)) directories.set(folder, mkdir(folder, { recursive: true, mode: 0o700 }));
          await directories.get(folder);
        }
        if (existing) { await existing.ready; await link(existing.path, destination); }
        else await writeFile(destination, data, { flag: 'wx', mode: 0o400 });
      })();
      if (!existing) copied.set(file.oid, { path: destination, bytes: file.bytes, ready: work });
      start(work);
    }
    await Promise.all(pending);
    if (failure) throw failure;
    child.stdin.end(); if (await exited !== 0 || spawnError) throw new Error('Git could not read the pinned source snapshot');
    onProgress(files.length, files.length);
  } catch (error) { throw failure || error; }
  finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await Promise.all(pending); await exited; }
}
async function changes(repository, base, head, before, after) {
  const raw = (await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--name-status', '-z', '--find-renames', '-l2000', base, head, '--'])).toString('utf8').split('\0');
  const oldFiles = new Map(before.map(file => [file.path, file])); const newFiles = new Map(after.map(file => [file.path, file])); const result = [];
  const empty = (await git(repository, ['hash-object', '-w', '--stdin'], { input: Buffer.alloc(0) })).toString('ascii').trim();
  for (let i = 0; i < raw.length && raw[i];) {
    const code = raw[i++][0], first = relativePath(raw[i++]); const second = code === 'R' ? relativePath(raw[i++]) : first;
    const oldPath = code === 'A' ? null : first, newPath = code === 'D' ? null : second;
    const old = oldFiles.get(oldPath), next = newFiles.get(newPath); let hunks = [];
    if (!old?.omitted && !next?.omitted) {
      const patch = (await git(repository, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--unified=0', old?.oid || empty, next?.oid || empty, '--'])).toString('utf8');
      hunks = [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map(match => ({ oldStart: Number(match[1]), oldCount: match[2] === undefined ? 1 : Number(match[2]), newStart: Number(match[3]), newCount: match[4] === undefined ? 1 : Number(match[4]) }));
      if (hunks.length > 20_000) throw new Error('A changed file exceeds the diff hunk limit');
    }
    const status = ({ A: 'added', D: 'deleted', R: 'renamed', T: 'type', M: 'modified' })[code];
    if (!status) throw new Error('Unsupported Git change status');
    result.push({ status, oldPath, newPath, hunks });
    if (result.length > 10_000) throw new Error('PR exceeds the 10,000 changed file limit');
  }
  return result;
}

function validateNumber(number) {
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new Error('PR number must be a positive integer');
}
async function projectRepository(project) {
  return project.repository ? repositoryName(project.repository) : githubRepository((await git(project.root, ['remote', 'get-url', 'origin'])).toString('utf8'));
}
function pinnedPr(pr, number, repository) {
  if (!pr || pr.number !== number || ![pr.baseSha, pr.headSha, pr.mergeBaseSha].every(value => typeof value === 'string' && SHA.test(value))) throw new Error('Invalid pinned PR metadata');
  return { number, title: String(pr.title || '').slice(0, 1000), url: `https://github.com/${repository}/pull/${number}`, baseSha: pr.baseSha, headSha: pr.headSha, mergeBaseSha: pr.mergeBaseSha };
}
export async function resolvePullRequest(project, number, { loadPr = githubPr, onProgress = () => {} } = {}) {
  validateNumber(number);
  onProgress({ phase: 'metadata', message: 'Checking the latest PR revisions…', completed: 0, total: 1 });
  const repository = await projectRepository(project);
  const pr = pinnedPr(await loadPr(repository, number), number, repository);
  onProgress({ phase: 'metadata', message: 'PR revisions pinned', completed: 1, total: 1 });
  return { repository, pr };
}

export async function prepareComparison(project, number, directory, { loadPr = githubPr, resolved, onProgress = () => {} } = {}) {
  validateNumber(number);
  if (!resolved) resolved = await resolvePullRequest(project, number, { loadPr, onProgress });
  else if (resolved.repository !== await projectRepository(project)) throw new Error('Invalid resolved PR metadata for this project');
  const repository = repositoryName(resolved.repository), pr = pinnedPr(resolved.pr, number, repository);
  const bare = join(directory, 'objects.git'); await mkdir(directory, { recursive: true, mode: 0o700 });
  await git(directory, ['init', '--bare', '--quiet', bare]);
  const common = (await git(project.root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString('utf8').trim();
  const objects = await realpath(join(common, 'objects'));
  if (objects.includes('\n') || objects.includes('\r')) throw new Error('Unsupported local Git object path');
  await writeFile(join(bare, 'objects/info/alternates'), objects + '\n');
  const revisions = [...new Set([pr.mergeBaseSha, pr.headSha])]; let fetched = 0;
  onProgress({ phase: 'fetch', message: 'Loading pinned Git objects…', completed: 0, total: revisions.length });
  for (const sha of revisions) {
    try { await git(bare, ['cat-file', '-e', `${sha}^{commit}`]); }
    catch {
      try { await git(bare, ['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=!gh auth git-credential', 'fetch', '--depth=1', '--no-tags', '--no-write-fetch-head', `https://github.com/${repository}.git`, sha], { objectDirectory: join(bare, 'objects') }); }
      catch (error) { if (/storage limit/.test(error.message)) throw error; throw new Error('Could not fetch the pinned PR commits. Check local GitHub credentials and retry.'); }
    }
    onProgress({ phase: 'fetch', message: 'Loading pinned Git objects…', completed: ++fetched, total: revisions.length });
  }
  onProgress({ phase: 'list', message: 'Reading the pinned file trees…', completed: 0, total: 2 });
  const [baseFiles, headFiles] = await Promise.all([entries(bare, pr.mergeBaseSha), entries(bare, pr.headSha)]);
  onProgress({ phase: 'list', message: 'Pinned file trees loaded', completed: 2, total: 2 });
  onProgress({ phase: 'diff', message: 'Comparing changed files…', completed: 0, total: 1 });
  const changed = await changes(bare, pr.mergeBaseSha, pr.headSha, baseFiles, headFiles);
  onProgress({ phase: 'diff', message: 'Changed files compared', completed: 1, total: 1 });
  const baseRoot = join(directory, 'before'), headRoot = join(directory, 'after'), budget = { bytes: 0 }, copied = new Map();
  await materialize(bare, baseFiles, baseRoot, budget, copied, (completed, total) => onProgress({ phase: 'before-materialize', message: 'Preparing Before source files…', completed, total }));
  await materialize(bare, headFiles, headRoot, budget, copied, (completed, total) => onProgress({ phase: 'after-materialize', message: 'Preparing After source files…', completed, total }));
  const warnings = [];
  for (const [side, files] of [['Before', baseFiles], ['After', headFiles]]) {
    const omitted = files.filter(file => file.omitted); if (omitted.length) warnings.push(`${side}: ${omitted.length} symlink, submodule or oversized files omitted from source analysis`);
  }
  const clean = files => files.map(({ path, bytes, omitted }) => ({ path, bytes, omitted }));
  const manifest = { version: 1, pr, baseRoot, headRoot, baseFiles: clean(baseFiles), headFiles: clean(headFiles), changes: changed, warnings };
  const manifestPath = join(directory, 'comparison.json'); await writeFile(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  return { root: headRoot, manifest: manifestPath, pr, directory };
}
