import { test } from 'node:test';
import assert from 'node:assert/strict';
import { corpusCandidates, selectCorpus } from '../core/bench.mjs';

// Evolution phase 1 step 5: fixed review inputs from the board's own history, split so tuning never sees eval cases.
const PR = 'https://github.com/acme-org/app/pull/', H = c => c.repeat(40);
const rec = (id, o) => ({ id, title: `t ${id}`, criteria: [{ id: 'AC1', text: 'does x' }], phase: 'done', links: { pr: `${PR}${id.slice(2)}` }, findings: [], reviews: [], ...o });
const state = { work: {
  // A human found a defect after our clean review, and it was fixed red-first: a confirmed miss.
  'W-1': rec('W-1', { reviews: [{ head: H('a'), by: 'sbx: s internal-review', result: 'clean', at: '2026-11-01T00:00:00Z', link: '/r1.md' }],
    findings: [{ id: 'F1', text: '1 new unresolved review thread(s): bob https://x/1', status: 'resolved', note: 'e8f4468 (W-1 R4): red-first with bob\'s repro.', source: { type: 'threads', at: '2026-11-02T00:00:00Z' } }] }),
  // Feedback after a clean review that needed nothing: not a miss.
  'W-2': rec('W-2', { reviews: [{ head: H('b'), by: 'sbx: s internal-review', result: 'clean', at: '2026-11-01T00:00:00Z' }],
    findings: [{ id: 'F1', text: 'comment', status: 'accepted', note: 'Nothing to fix or answer.', source: { type: 'comments', at: '2026-11-02T00:00:00Z' } }] }),
  // Our review found defects that a later round fixed.
  'W-3': rec('W-3', { reviews: [{ head: H('c'), by: 'sbx: s internal-review', result: 'findings', at: '2026-11-03T00:00:00Z', link: '/r3.md' }, { head: H('d'), by: 'sbx: s internal-review', result: 'clean', at: '2026-11-04T00:00:00Z' }],
    findings: [{ id: 'F1', text: 'nil crash in X', severity: 'high', status: 'resolved', reviewHead: H('c') }] }),
  // Merged after one clean review and no feedback: a clean case.
  'W-4': rec('W-4', { reviews: [{ head: H('e'), by: 'sbx: s internal-review', result: 'clean', at: '2026-11-05T00:00:00Z' }] }),
  // Not merged: not a clean case.
  'W-5': rec('W-5', { phase: 'review', reviews: [{ head: H('f'), by: 'sbx: s internal-review', result: 'clean', at: '2026-11-05T00:00:00Z' }] }),
} };

test('candidates are confirmed misses, fixed findings and clean merged reviews, each pinned to the reviewed head', () => {
  const c = corpusCandidates(state);
  assert.deepEqual(c.miss.map(x => [x.work, x.head, x.expected[0].confirmedBy]), [['W-1', H('a'), 'e8f4468']]);
  assert.deepEqual(c.defect.map(x => [x.work, x.head, x.expected[0].text]), [['W-3', H('c'), 'nil crash in X']]);
  assert.deepEqual(c.clean.map(x => [x.work, x.head]), [['W-4', H('e')]]);
  assert.deepEqual(c.miss[0].criteria, ['AC1: does x']);
  assert.equal(c.miss[0].repo, 'acme-org/app');
});

test('selection is stable, and every case is either eval or tune by its id alone', () => {
  const c = corpusCandidates(state), a = selectCorpus(c, { miss: 1, defect: 1, clean: 1 }), b = selectCorpus(c, { miss: 1, defect: 1, clean: 1 });
  assert.deepEqual(a, b);
  assert.equal(a.length, 3);
  for (const x of a) assert.ok(['eval', 'tune'].includes(x.split));
});

test('two findings on one reviewed head, or two records on one PR head, make one case', () => {
  const twice = { work: {
    'W-1': state.work['W-1'],
    'W-9': { ...state.work['W-1'], id: 'W-9', findings: [...state.work['W-1'].findings, { ...state.work['W-1'].findings[0], id: 'F2', note: 'abc1234: fixed, red-first' }] },
  } };
  const c = corpusCandidates(twice);
  assert.equal(c.miss.length, 1);
  assert.equal(c.miss[0].expected.length, 2);
});

test('the quality report counts reviews, retained evidence, manifests and unadjudicated escapes since a time', async () => {
  const { qualityReport } = await import('../core/bench.mjs');
  const s = { work: { 'W-1': state.work['W-1'], 'W-3': state.work['W-3'] },
    artifacts: { k: { work: 'W-3', head: H('c'), status: 'retained' } },
    manifests: { 'W-3/R1/1': { run: { work: 'W-3' } } } };
  s.work['W-3'] = { ...s.work['W-3'], assignments: [{ id: 'R1', history: [{ status: 'started', at: '2026-11-03T00:00:00Z' }] }] };
  const r = qualityReport(s, '2026-11-01T00:00:00Z');
  assert.deepEqual(r.reviews, { total: 3, clean: 2, findings: 1, evidenceRetained: 1 });
  assert.deepEqual(r.runs, { started: 1, withManifest: 1 });
  assert.equal(r.escapesUnadjudicated, 1);
});

test('an 8-digit task id in a note is not a fix commit', () => {
  const w = { work: { 'W-1': { ...state.work['W-1'], findings: [{ ...state.work['W-1'].findings[0], note: 'Answered on Teamwork 41073672.' }] } } };
  assert.equal(corpusCandidates(w).miss.length, 0);
});
