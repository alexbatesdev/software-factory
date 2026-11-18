// W-558: outcomes by agent, from what the factory already records. Neutral fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outcomes, outcomesMarkdown } from '../core/outcomes.mjs';

// As the reducer writes it: each entry is the status being left, at the change (queued left at start, started left at done).
const H = (start, end) => [{ status: 'queued', at: start }, { status: 'started', at: end }];
const work = {
  'W-1': { id: 'W-1', assignments: [{ id: 'R1', kind: 'implementation', owner: 'sbx: s2', status: 'done', history: H('2026-11-10T10:00:00Z', '2026-11-10T11:00:00Z') },
                                    { id: 'R2', kind: 'review', owner: 'sbx: s1', status: 'done', history: H('2026-11-10T12:00:00Z', '2026-11-10T12:30:00Z') }],
    reviews: [{ result: 'findings', at: '2026-11-10T12:30:00Z' }, { result: 'clean', at: '2026-11-10T14:00:00Z' }],
    findings: [{ source: { type: 'ci' } }, { source: { type: 'threads', at: '2026-11-11T09:00:00Z' } }, { source: { type: 'changes_requested', at: '2026-11-11T09:00:00Z', ids: ['a', 'b'] } }] },
  'W-2': { id: 'W-2', assignments: [{ id: 'R1', kind: 'implementation', owner: 'sbx: s1', status: 'done', history: H('2026-11-12T10:00:00Z', '2026-11-12T13:00:00Z') }],
    reviews: [{ result: 'clean', at: '2026-11-12T14:00:00Z' }], findings: [{ source: { type: 'threads', at: '2026-11-12T13:30:00Z' } }] },
  'W-3': { id: 'W-3', assignments: [{ id: 'R1', kind: 'implementation', owner: 'sbx: s2', status: 'done', history: H('2026-11-01T10:00:00Z', '2026-11-01T11:00:00Z') }], reviews: [], findings: [] },
};
const cfg = { since: '2026-11-09T00:00:00Z', until: '2026-11-16T00:00:00Z', codexSince: { s2: '2026-11-09T00:00:00Z' } };

test('jobs and PRs are counted by the agent that ran them: the manifest when it says, else the stream and when it went Codex', () => {
  const r = outcomes({ work, manifests: { 'W-2/R1/1': { harness: { agent: 'codex' } } } }, cfg);
  assert.deepEqual(r.jobs.map(j => [j.agent, j.kind, j.count, j.medianMinutes]), [['codex', 'implementation', 2, 120], ['claude', 'review', 1, 30]]);
  const by = Object.fromEntries(r.prs.map(p => [p.agent, p]));
  assert.deepEqual([by.codex.records, by.codex.reviewRoundsToClean, by.codex.feedbackAfterClean, by.codex.changesRequested, by.codex.redCi], [2, 0.5, 1, 2, 1]);
  assert.ok(!r.prs.some(p => p.records === 0));
});

test('the report says what it could not measure instead of guessing', () => {
  const md = outcomesMarkdown(outcomes({ work, manifests: {} }, cfg), cfg);
  assert.match(md, /jobs before that, host-stream workers and Codex supervisor seats have none/);
  assert.match(md, /\| claude \| review \| 1 \| 30 \| 0 \| none \| none \|/, 'a job with no token count says none, not 0');
});
