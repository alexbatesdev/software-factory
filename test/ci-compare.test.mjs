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
