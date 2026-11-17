import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareCheck, compareText } from '../core/ci-compare.mjs';

// W-501 (Alex 11-16): "compare which specs failed on most recent run and the fails on main".
const job = (tests, status = 'failed') => ({ status, tests });

test('a check is red on main only when every test failing on the PR also fails on main', () => {
  assert.deepEqual(compareCheck(job(['spec/a_spec.rb::x']), job(['spec/a_spec.rb::x', 'spec/b_spec.rb::y'])), { verdict: 'red on main', prOnly: [], shared: ['spec/a_spec.rb::x'] });
  assert.deepEqual(compareCheck(job(['spec/a_spec.rb::x', 'spec/c_spec.rb::z']), job(['spec/a_spec.rb::x'])), { verdict: 'ours', prOnly: ['spec/c_spec.rb::z'], shared: ['spec/a_spec.rb::x'] });
});

test('a job that failed before any test ran is "no test results", never red on main (W-282: #8638 died at Start services)', () => {
  assert.equal(compareCheck(job(null), job(['spec/a_spec.rb::x'])).verdict, 'no test results');
  assert.equal(compareCheck(job([]), job(['spec/a_spec.rb::x'])).verdict, 'no test results');
});

test("with no run of the job to compare (not read, or main's job didn't fail on tests) the result is unknown, and names don't decide it", () => {
  assert.equal(compareCheck(undefined, job(['a'])).verdict, 'unknown');
  assert.equal(compareCheck(job(['a']), undefined).verdict, 'ours', 'main has no failing run of this job: the failure is the PR\'s');
  assert.equal(compareCheck(job(['a']), job(null)).verdict, 'unknown', "main's job died before its tests: can't compare");
});

test('the comparison reads as one line per check for the record', () => {
  assert.equal(compareText('ci/circleci: unit-tests', { verdict: 'ours', prOnly: ['spec/c_spec.rb::z', 'spec/d_spec.rb::w'], shared: ['spec/a_spec.rb::x'] }),
    'ci/circleci: unit-tests: 2 test(s) fail here and not on main (spec/c_spec.rb::z, spec/d_spec.rb::w); 1 also fail on main.');
  assert.match(compareText('ci/circleci: unit-tests', { verdict: 'no test results', prOnly: [], shared: [] }), /failed before any test ran: rerun it/);
  assert.match(compareText('ci/circleci: test', { verdict: 'red on main', prOnly: [], shared: ['a', 'b'] }), /all 2 failing test\(s\) also fail on main/);
});

test("the reader takes the newest finished pipeline at the commit, and a failed job with no test results reads as none ran", async () => {
  process.env.CIRCLE_TOKEN ||= 'test';
  const { readJobFailures } = await import('../sources/circleci.mjs');
  const routes = {
    '/project/gh/o/app/pipeline': { items: [{ id: 'p-new', vcs: { revision: 'other' } }, { id: 'p-run', vcs: { revision: 'abc' } }, { id: 'p-done', vcs: { revision: 'abc' } }] },
    '/pipeline/p-run/workflow': { items: [{ id: 'w-run', status: 'running' }] },
    '/pipeline/p-done/workflow': { items: [{ id: 'w1', status: 'failed' }] },
    '/workflow/w1/job': { items: [{ name: 'unit-tests', status: 'failed', job_number: 7 }, { name: 'test', status: 'failed', job_number: 8 }, { name: 'lint', status: 'success', job_number: 9 }] },
    '/project/gh/o/app/7/tests': { items: [] },
    '/project/gh/o/app/8/tests': { items: [{ file: 'spec/a_spec.rb', name: 'x', result: 'failure' }, { file: 'spec/b_spec.rb', name: 'y', result: 'success' }] },
  };
  const f = async url => { const path = url.replace('https://circleci.com/api/v2', '').split('?')[0]; return { ok: !!routes[path], status: routes[path] ? 200 : 404, json: async () => routes[path] }; };
  const jobs = await readJobFailures('gh/o/app', 'b', 'abc', f);
  assert.deepEqual(Object.fromEntries(jobs), { 'ci/circleci: unit-tests': { status: 'failed', tests: null }, 'ci/circleci: test': { status: 'failed', tests: ['spec/a_spec.rb::x'] }, 'ci/circleci: lint': { status: 'success', tests: [] } });
});

test('a GitHub App pipeline names its commit in trigger_parameters, and a queued workflow is not finished (W-501, seen live 11-16)', async () => {
  process.env.CIRCLE_TOKEN ||= 'test';
  const { readJobFailures } = await import('../sources/circleci.mjs');
  const routes = {
    '/project/gh/o/app/pipeline': { items: [{ id: 'p-q', trigger_parameters: { github_app: { commit_sha: 'abc' } } }, { id: 'p-ok', trigger_parameters: { github_app: { commit_sha: 'abc' } } }] },
    '/pipeline/p-q/workflow': { items: [{ id: 'wq', status: 'queued' }, { id: 'ws', status: 'success' }] },
    '/pipeline/p-ok/workflow': { items: [{ id: 'w1', status: 'failed' }] },
    '/workflow/w1/job': { items: [{ name: 'test', status: 'failed', job_number: 8 }] },
    '/project/gh/o/app/8/tests': { items: [{ file: 'spec/a_spec.rb', name: 'x', result: 'failure' }] },
  };
  const f = async url => { const path = url.replace('https://circleci.com/api/v2', '').split('?')[0]; return { ok: !!routes[path], status: routes[path] ? 200 : 404, json: async () => routes[path] }; };
  assert.deepEqual(Object.fromEntries(await readJobFailures('gh/o/app', 'b', 'abc', f)), { 'ci/circleci: test': { status: 'failed', tests: ['spec/a_spec.rb::x'] } });
});

test("a job that fails with no test results on main as well (a fan-in like ci/circleci: test, seen 11-16) is unknown, so the name match decides", () => {
  assert.equal(compareCheck(job(null), job(null)).verdict, 'unknown');
  assert.equal(compareCheck(job(null), job(['a'])).verdict, 'no test results', 'main ran tests and the PR ran none: rerun');
});

// On-demand Brakeman (Alex 11-16): the Audit check is Brakeman alone (CI's bundler-audit step always exits 0).
test("Brakeman's JSON becomes warnings keyed by fingerprint; the PR's warnings are main's only when every one is on main", async () => {
  const { parseBrakeman } = await import('../sources/audit.mjs');
  const { compareWarnings } = await import('../core/ci-compare.mjs');
  const json = { warnings: [{ fingerprint: 'f1', warning_type: 'SQL Injection', confidence: 'Medium', file: 'app/q.rb', line: 782, message: 'Possible SQL injection' }] };
  assert.deepEqual(parseBrakeman(JSON.stringify(json)), [{ fingerprint: 'f1', type: 'SQL Injection', confidence: 'Medium', file: 'app/q.rb', line: 782, message: 'Possible SQL injection' }]);
  const w = (fp, file = 'app/q.rb') => ({ fingerprint: fp, type: 'SQL Injection', file, line: 1 });
  assert.deepEqual(compareWarnings([w('f1')], [w('f1'), w('f2')]), { verdict: 'red on main', prOnly: [], shared: ['SQL Injection app/q.rb:1'], unit: 'Brakeman warning' });
  assert.deepEqual(compareWarnings([w('f1'), w('f3', 'app/new.rb')], [w('f1')]).prOnly, ['SQL Injection app/new.rb:1']);
  assert.equal(compareWarnings([], [w('f1')]).verdict, 'unknown', 'Brakeman finds nothing here: the red check is something else');
});

test('the comparison line names Brakeman warnings, not tests', async () => {
  const { compareText } = await import('../core/ci-compare.mjs');
  assert.equal(compareText('Audit Ruby code and dependencies', { verdict: 'ours', prOnly: ['SQL Injection app/new.rb:1'], shared: [], unit: 'Brakeman warning' }),
    'Audit Ruby code and dependencies: 1 Brakeman warning(s) here and not on main (SQL Injection app/new.rb:1).');
  assert.match(compareText('Audit Ruby code and dependencies', { verdict: 'red on main', prOnly: [], shared: ['a', 'b'], unit: 'Brakeman warning' }), /all 2 Brakeman warning\(s\) are also on main/);
});

// W-520: #8869 fixed main's Audit at 23:21Z; branches cut before it still carry those warnings.
test("warnings a PR carries from where it branched off, gone from main since, are 'fixed on main': merge main, no code fix", async () => {
  const { compareWarnings, compareText } = await import('../core/ci-compare.mjs');
  const w = (fp, line) => ({ fingerprint: fp, type: 'SQL Injection', file: 'app/q.rb', line });
  const c = compareWarnings([w('f1', 122), w('f2', 782)], [], [w('f1', 122), w('f2', 782)]);
  assert.deepEqual([c.verdict, c.prOnly.length], ['fixed on main', 2]);
  assert.match(compareText('Audit Ruby code and dependencies', c), /2 Brakeman warning\(s\) here are fixed on main since this branch's base.*merge origin\/main.*no code fix/);
  assert.equal(compareWarnings([w('f1', 122), w('f9', 5)], [], [w('f1', 122)]).verdict, 'ours', 'one warning new on the branch: the PR\'s');
});

// W-532 (Alex 11-17): PRs red only because their branch lacks fixes main has, while main is red on something unrelated.
test("failing tests whose files main changed since the branch point, and the PR didn't touch, are 'fixed on main'", async () => {
  const { staleOnMain } = await import('../core/ci-compare.mjs');
  const tests = ['spec/support/example_watchdog_spec.rb::times out', 'spec/queries/datasheet_spec.rb::row scope'];
  const main = ['spec/support/example_watchdog_spec.rb', 'spec/queries/datasheet_spec.rb', 'app/queries/datasheet.rb'];
  assert.equal(staleOnMain(tests, [], main), true);
  assert.equal(staleOnMain(tests, ['spec/queries/datasheet_spec.rb'], main), false, 'the PR changed that spec: maybe its own');
  assert.equal(staleOnMain(tests, [], ['spec/support/example_watchdog_spec.rb']), false, 'one failing file main never changed');
  assert.equal(staleOnMain([], [], main), false, 'no failing tests: nothing to place');
});

test("a check whose failing tests main has since fixed reads 'merge origin/main', even while main is red on other tests", async () => {
  const { compareCheck, withStaleness, compareText } = await import('../core/ci-compare.mjs');
  const pr = { status: 'failed', tests: ['spec/a_spec.rb::x'] }, mainDiedEarly = { status: 'failed', tests: null };
  const c = withStaleness(compareCheck(pr, mainDiedEarly), pr, { prFiles: [], mainFiles: ['spec/a_spec.rb'] });
  assert.equal(c.verdict, 'fixed on main');
  assert.match(compareText('ci/circleci: unit-tests', c), /fixed on main since this branch's base.*merge origin\/main.*no code fix/);
  assert.equal(withStaleness(compareCheck(pr, { status: 'failed', tests: ['spec/a_spec.rb::x'] }), pr, { prFiles: [], mainFiles: ['spec/a_spec.rb'] }).verdict, 'red on main', 'the same test still fails on main: main\'s');
});
