import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareComparison, githubRepository } from './pr-snapshots.mjs';

const env = { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' };
const git = (root, ...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', root, ...args], { encoding: 'utf8', env }).trim();
async function fixture(t, extraFiles = 0) {
  const directory = await mkdtemp(join(tmpdir(), 'spamton-pr-snapshots-')), root = join(directory, 'repo'); await mkdir(root); git(root, 'init', '-q');
  await writeFile(join(root, 'app.rb'), 'class App\n  def run\n    1\n  end\nend\n');
  await writeFile(join(root, 'old name\tfile.txt'), 'renamed content\n'); await writeFile(join(root, 'removed.rb'), 'class Removed; end\n');
  for (let i = 0; i < extraFiles; i++) await writeFile(join(root, 'extra-' + i + '.rb'), 'class Extra; ' + Math.floor(i / 2) + '; end\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'Before'); const base = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'app.rb'), 'class App\n  def run\n    2\n  end\nend\n');
  git(root, 'mv', 'old name\tfile.txt', 'new name\nfile.txt'); git(root, 'rm', '-q', 'removed.rb');
  await writeFile(join(root, 'added.ts'), 'export function added() { return 3; }\n'); await symlink('/etc/passwd', join(root, 'outside.rb'));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'After'); const head = git(root, 'rev-parse', 'HEAD');
  await writeFile(join(root, 'app.rb'), 'uncommitted changes must remain untouched\n'); await writeFile(join(root, 'untracked.txt'), 'never copy this\n');
  git(root, 'remote', 'add', 'origin', 'git@github.com:fixture/project.git');
  const status = git(root, 'status', '--porcelain=v1');
  const loadPr = async (repo, number) => { assert.equal(repo, 'fixture/project'); assert.equal(number, 42); return { number, title: 'Fixture PR', url: 'https://github.com/fixture/project/pull/42', baseSha: base, mergeBaseSha: base, headSha: head }; };
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, root, base, head, status, loadPr };
}

test('only trusted GitHub origin formats resolve repositories', () => {
  for (const url of ['https://github.com/owner/repo.git', 'git@github.com:owner/repo.git', 'ssh://git@github.com/owner/repo', 'https://github.com/owner/repo/']) assert.equal(githubRepository(url), 'owner/repo');
  for (const url of ['file:///tmp/repo', 'https://evil.test/owner/repo', 'https://github.com/a/../b', 'git@github.com:owner/repo;command', 'https://token@github.com/a/b']) assert.throws(() => githubRepository(url));
});

test('snapshots use pinned Git objects, retain renames and deletions, and do not touch a dirty checkout', async t => {
  const f = await fixture(t); const target = join(f.directory, 'snapshot');
  const comparison = await prepareComparison({ root: f.root }, 42, target, { loadPr: f.loadPr });
  const manifest = JSON.parse(await readFile(comparison.manifest, 'utf8'));
  assert.equal(await readFile(join(manifest.baseRoot, 'app.rb'), 'utf8'), 'class App\n  def run\n    1\n  end\nend\n');
  assert.equal(await readFile(join(manifest.headRoot, 'app.rb'), 'utf8'), 'class App\n  def run\n    2\n  end\nend\n');
  assert.equal(git(f.root, 'status', '--porcelain=v1'), f.status); assert.equal(git(f.root, 'rev-parse', 'HEAD'), f.head);
  await assert.rejects(access(join(manifest.headRoot, 'untracked.txt'))); await assert.rejects(access(join(manifest.headRoot, 'outside.rb')));
  assert.match(manifest.headFiles.find(file => file.path === 'outside.rb').omitted, /Symlink/);
  const modified = manifest.changes.find(file => file.newPath === 'app.rb'); assert.deepEqual(modified.hunks, [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1 }]);
  const rename = manifest.changes.find(file => file.status === 'renamed'); assert.equal(rename.oldPath, 'old name\tfile.txt'); assert.equal(rename.newPath, 'new name\nfile.txt'); assert.equal(rename.hunks.length, 0);
  assert(manifest.changes.some(file => file.status === 'deleted' && file.oldPath === 'removed.rb'));
  assert(manifest.changes.some(file => file.status === 'added' && file.newPath === 'added.ts'));
  assert.equal(manifest.pr.mergeBaseSha, f.base); assert(manifest.warnings.length > 0);
});

test('invalid PR numbers and arbitrary configured repository paths are rejected before loading metadata', async t => {
  const f = await fixture(t); let called = false; const loadPr = async () => { called = true; throw new Error('unexpected'); };
  for (const number of [0, -1, 1.5, '../42', 2147483648]) await assert.rejects(prepareComparison({ root: f.root }, number, join(f.directory, 'bad'), { loadPr }), /positive integer/);
  await assert.rejects(prepareComparison({ root: f.root, repository: '../other' }, 42, join(f.directory, 'bad'), { loadPr }), /Invalid configured/);
  assert.equal(called, false);
});

test('identical pinned blobs share snapshot storage without linking to the working checkout', async t => {
  const f = await fixture(t);
  const comparison = await prepareComparison({ root: f.root }, 42, join(f.directory, 'snapshot'), { loadPr: f.loadPr });
  const before = await stat(join(comparison.directory, 'before', 'old name\tfile.txt'));
  const after = await stat(join(comparison.directory, 'after', 'new name\nfile.txt'));
  const checkout = await stat(join(f.root, 'new name\nfile.txt'));
  assert.equal(after.ino, before.ino, 'unchanged content must be materialized only once across pinned revisions');
  assert.equal(after.dev, before.dev);
  assert.notEqual(after.ino, checkout.ino, 'snapshots must not share writable checkout storage');
  assert.equal(after.mode & 0o777, 0o400);
});

test('snapshot filesystem work overlaps within four jobs and duplicate blobs wait for the copied file', async t => {
  const f = await fixture(t, 12), target = join(f.directory, 'snapshot'); let active = 0, maximum = 0;
  const original = { writeFile: fs.writeFile, link: fs.link, mkdir: fs.mkdir };
  const owned = path => String(path).startsWith(join(target, 'before')) || String(path).startsWith(join(target, 'after'));
  const delayed = operation => async (...args) => {
    if (!owned(args[0]) && !owned(args[1])) return original[operation](...args);
    active++; maximum = Math.max(maximum, active);
    try {
      await new Promise(done => setTimeout(done, operation === 'writeFile' ? 50 : 1));
      if (operation === 'link') await access(args[0]);
      return await original[operation](...args);
    } finally { active--; }
  };
  for (const operation of Object.keys(original)) fs[operation] = delayed(operation);
  syncBuiltinESMExports();
  try { await prepareComparison({ root: f.root }, 42, target, { loadPr: f.loadPr }); }
  finally { Object.assign(fs, original); syncBuiltinESMExports(); }
  assert(maximum > 1, 'snapshot I/O must overlap instead of awaiting every file');
  assert(maximum <= 4, 'snapshot I/O must remain bounded to four jobs');
  assert.equal(active, 0);
  const first = await stat(join(target, 'before', 'extra-0.rb')), duplicate = await stat(join(target, 'before', 'extra-1.rb'));
  assert.equal(first.ino, duplicate.ino);
});

test('failed snapshot work settles every started write before returning its original error', async t => {
  const f = await fixture(t, 12), target = join(f.directory, 'snapshot'), original = fs.writeFile;
  const failure = new Error('fixture snapshot write failed'); let active = 0, started = 0, completed = 0;
  fs.writeFile = async (...args) => {
    if (!String(args[0]).startsWith(join(target, 'before'))) return original(...args);
    const at = started++; active++;
    try {
      await new Promise(done => setTimeout(done, at === 0 ? 15 : 50));
      if (at === 0) throw failure;
      return await original(...args);
    } finally { active--; completed++; }
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareComparison({ root: f.root }, 42, target, { loadPr: f.loadPr }), error => error === failure);
    assert(started > 1, 'failure must occur while another snapshot write is pending');
    assert.equal(active, 0, 'all pending writes must settle before the snapshot is cleaned up');
    const settled = completed; await new Promise(done => setTimeout(done, 70)); assert.equal(completed, settled);
  } finally { fs.writeFile = original; syncBuiltinESMExports(); }
});

test('resolved PR metadata is validated and reused without another GitHub lookup', async t => {
  const f = await fixture(t); const { resolvePullRequest } = await import('./pr-snapshots.mjs'); let lookups = 0;
  const progress = [];
  const resolved = await resolvePullRequest({ root: f.root }, 42, { loadPr: async (...args) => { lookups++; return f.loadPr(...args); }, onProgress: value => progress.push(value) });
  assert.equal(resolved.repository, 'fixture/project');
  const comparison = await prepareComparison({ root: f.root }, 42, join(f.directory, 'snapshot'), { resolved, loadPr: async () => { lookups++; throw new Error('metadata was already resolved'); }, onProgress: value => progress.push(value) });
  assert.equal(lookups, 1);
  assert.equal(comparison.pr.headSha, f.head);
  for (const value of progress) { assert(Number.isSafeInteger(value.completed)); assert(Number.isSafeInteger(value.total)); assert(value.completed <= value.total); }
  assert(progress.some(value => value.phase === 'metadata' && value.completed === value.total));
  assert(progress.some(value => value.phase === 'after-materialize' && value.completed === value.total));
  await assert.rejects(prepareComparison({ root: f.root }, 42, join(f.directory, 'bad'), { resolved: { ...resolved, repository: 'other/project' } }), /resolved PR metadata/);
  await assert.rejects(prepareComparison({ root: f.root }, 43, join(f.directory, 'bad'), { resolved }), /pinned PR metadata/);
});

test('preparation helper resolves once, then prepares with opt-in progress frames', async t => {
  const f = await fixture(t), bin = join(f.directory, 'bin'), calls = join(f.directory, 'spamton-gh-calls'); await mkdir(bin);
  await writeFile(join(bin, 'gh'), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(calls)},'call\\n');const path=process.argv[3];if(path==='repos/fixture/project/pulls/42')console.log(JSON.stringify(${JSON.stringify({ number: 42, title: 'Fixture PR', repository: 'fixture/project', baseSha: f.base, headSha: f.head })}));else if(path?.startsWith('repos/fixture/project/compare/'))console.log(${JSON.stringify(f.base)});else process.exit(1);\n`, { mode: 0o755 });
  for (const progress of [false, true]) {
    const frames = [], child = spawn(process.execPath, [fileURLToPath(new URL('./pr-prepare.mjs', import.meta.url)), ...(progress ? ['--progress'] : [])], { env: { ...env, PATH: bin + ':' + process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume(); const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try {
      await new Promise((done, reject) => {
        child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error('helper exited with code ' + code)));
        createInterface({ input: child.stdout }).on('line', line => {
          try {
            const frame = JSON.parse(line); frames.push(frame); assert.equal(frame.error, undefined);
            if (frame.id === 1 && frame.result) child.stdin.write(JSON.stringify({ id: 2, op: 'prepare', project: { root: f.root }, number: 42, directory: join(f.directory, 'helper-' + progress), resolved: frame.result }) + '\n');
            if (frame.id === 2 && frame.result) child.stdin.end();
          } catch (error) { reject(error); child.kill('SIGKILL'); }
        });
        child.stdin.write(JSON.stringify({ id: 1, op: 'resolve', project: { root: f.root }, number: 42 }) + '\n');
      });
    } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    assert.deepEqual(frames.filter(frame => frame.result).map(frame => frame.id), [1, 2]);
    assert.equal(frames.some(frame => frame.progress), progress);
    if (progress) {
      assert(frames.some(frame => frame.id === 1 && frame.progress?.phase === 'metadata'));
      assert(frames.some(frame => frame.id === 2 && frame.progress?.phase === 'after-materialize'));
      for (const { progress: value } of frames.filter(frame => frame.progress)) assert(Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0);
    }
  }
  assert.equal((await readFile(calls, 'utf8')).trim().split('\n').length, 4, 'each load resolves PR and merge-base once, then preparation makes no GitHub calls');
});

test('fetching missing revisions excludes deleted historical blobs', async t => {
  const { randomBytes } = await import('node:crypto');
  const directory = await mkdtemp(join(tmpdir(), 'spamton-pr-fetch-')); const remote = join(directory, 'remote'), root = join(directory, 'local'), bin = join(directory, 'spamton-bin');
  for (const path of [remote, root, bin]) await mkdir(path);
  t.after(() => rm(directory, { recursive: true, force: true }));
  git(remote, 'init', '-q'); await writeFile(join(remote, 'app.rb'), 'class App; end\n'); git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'Before'); const base = git(remote, 'rev-parse', 'HEAD');
  await writeFile(join(remote, 'past.bin'), randomBytes(2 * 1024 * 1024)); git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'Historical asset'); const historical = git(remote, 'rev-parse', 'HEAD:past.bin');
  git(remote, 'rm', '-q', 'past.bin'); await writeFile(join(remote, 'app.rb'), 'class App; def run; 1; end; end\n'); git(remote, 'add', '.'); git(remote, 'commit', '-qm', 'After'); const head = git(remote, 'rev-parse', 'HEAD');
  git(root, 'init', '-q');
  await writeFile(join(bin, 'git'), `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';const args=process.argv.slice(2);const at=args.indexOf('https://github.com/fixture/project.git');if(at>=0)args[at]=${JSON.stringify(remote)};const r=spawnSync('/usr/bin/git',args,{stdio:'inherit'});process.exit(r.status??1);\n`, { mode: 0o755 });
  const oldPath = process.env.PATH; process.env.PATH = bin + ':' + oldPath;
  try {
    const module = await import('./pr-snapshots.mjs?fetch-regression=' + Date.now());
    const result = await module.prepareComparison({ root, repository: 'fixture/project' }, 42, join(directory, 'snapshot'), { loadPr: async () => ({ number: 42, title: 'Fixture', url: 'https://github.com/fixture/project/pull/42', baseSha: base, mergeBaseSha: base, headSha: head }) });
    assert.throws(() => git(join(result.directory, 'objects.git'), 'cat-file', '-e', historical), 'deleted historical blob was unnecessarily fetched');
    assert.equal(await readFile(join(result.root, 'app.rb'), 'utf8'), 'class App; def run; 1; end; end\n');
  } finally { process.env.PATH = oldPath; }
});
