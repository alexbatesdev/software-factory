import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statusOf } from '../views/status.mjs';

const base = (over = {}) => ({ id: 'W-1', phase: 'clarification', kind: 'build', source: { type: 'teamwork', key: 'tw-1' }, reviews: [], requests: [], assignments: [], liveAssignments: [], openDeps: [], externalDeps: [], links: {}, ...over });

test('one status: the label, the triage flag, the run scope and the waiting line agree', () => {
  const waiting = statusOf(base({ coverage: { state: 'none' }, waitingOn: { who: 'design', what: 'the design output' } }));
  assert.deepEqual([waiting.needs.triage, waiting.triageable, waiting.label, waiting.waiting.text, waiting.category],
    [false, false, 'Waiting on design', 'Waiting on design: the design output', 'waiting']);
  const uncovered = statusOf(base({ coverage: { state: 'unknown' } }));
  assert.deepEqual([uncovered.needs.triage, uncovered.triageable, uncovered.label], [true, true, 'Coverage unknown: needs triage']);
  const owned = statusOf(base({ coverage: { state: 'unknown' }, stream: 'sup: s1' }));
  assert.deepEqual([owned.needs.triage, owned.triageable, owned.triageSkip], [true, false, 'owned by sup: s1; its supervisor handles it']);
  const held = statusOf(base({ phase: 'intake' }), { held: true });
  assert.deepEqual([held.needs.triage, held.triageable, held.triageSkip], [true, false, 'held untriaged by Alex']);
});

test('a question joined by item or by record counts the same everywhere', () => {
  const q = { id: 'TB-1', status: 'open', verification: 'verified', title: 'Pick', options: [] };
  const s = statusOf(base(), { questions: [q] });
  assert.deepEqual([s.needs.me, s.category, s.waiting.who], [true, 'clarify', 'you']);
});

test('an answer that reached nobody asks Alex to pick a stream, unless the record is parked or closed', () => {
  const ans = { id: 'TB-9', status: 'answered', title: 'Which ATS?', answer: { choice: 'a', at: '2026-10-28T18:31:00Z', unsent: 'no stream supervisor on the record and no asking pane' }, options: [] };
  const s = statusOf(base(), { questions: [ans] });
  assert.equal(s.needs.me, true);
  assert.match(s.waiting.text, /^Waiting on you: pick a stream for W-1 so your answer to TB-9 reaches someone/);
  assert.equal(statusOf(base({ waitingOn: { who: 'design', what: 'x' } }), { questions: [ans] }).needs.me, false, 'parked: nobody to tell');
  assert.equal(statusOf(base({ phase: 'done' }), { questions: [ans] }).needs.me, false);
  assert.equal(statusOf(base({ stream: 'sup: s1' }), { questions: [ans] }).needs.me, false, 'a stream will receive it');
});

test('columns: In progress only while an agent works; open ready PRs wait on review; members live inside their PR unit', () => {
  const started = { id: 'R1', kind: 'fixes', status: 'started' };
  const unit = (over = {}) => base({ id: 'W-86', kind: 'pr-feedback', source: { type: 'pr', key: 'built-rails-8244' }, links: { pr: 'u' }, ...over });
  const col = (w, group = {}) => statusOf(w, { group }).category;
  assert.equal(col(unit({ phase: 'awaiting_human_approval' }), { isUnit: true, pr: { state: 'OPEN', isDraft: false } }), 'prreview');
  assert.equal(col(unit({ phase: 'fixes', assignments: [started] }), { isUnit: true, pr: { state: 'OPEN', isDraft: false } }), 'progress');
  assert.equal(col(unit({ phase: 'awaiting_human_approval' }), { isUnit: true, pr: { state: 'OPEN', isDraft: false }, activeMember: 'W-120 R1' }), 'progress', 'a child being worked makes the unit In progress');
  assert.equal(col(base({ phase: 'awaiting_human_approval' }), { units: [{ id: 'W-86', phase: 'awaiting_human_approval' }] }), 'in-unit');
  assert.equal(col(base({ phase: 'awaiting_human_approval' }), { units: [{ id: 'W-86', phase: 'done' }] }), 'prreview', 'its unit closed: back on its own card');
  const idle = statusOf(base({ phase: 'implementation', stream: 'sup: s1' }), { group: {} });
  assert.deepEqual([idle.category, idle.view === 'progress'], ['waiting', false], 'a phase with nobody working is not In progress');
  assert.equal(col(base({ phase: 'queued' })), 'ready');
  assert.equal(col(unit({ phase: 'intake' }), { isUnit: true, pr: { state: 'OPEN', isDraft: true } }), 'waiting', 'a quiet draft PR waits');
  assert.equal(statusOf(unit({ phase: 'awaiting_human_approval' }), { group: { isUnit: true, pr: { state: 'OPEN', isDraft: false } } }).view, 'prreview');
});

test('a record\'s list view never contradicts its column', () => {
  const quietPr = base({ phase: 'intake', kind: 'pr-feedback', source: { type: 'pr', key: 'built-rails-1' }, upstream: 'gone' });
  const s = statusOf(quietPr, { group: { isUnit: true, pr: { state: 'OPEN', isDraft: false } } });
  assert.deepEqual([s.category, s.view], ['prreview', 'prreview']);
});

test('a PR unit with no lifecycle of its own shows where its lead task is, never "Intake" or "Waiting on triage"', () => {
  const unit = base({ id: 'W-109', phase: 'intake', kind: 'pr-feedback', source: { type: 'pr', key: 'built-rails-8419' }, upstream: 'gone' });
  const lead = { id: 'W-82', label: 'Fixing review findings', waiting: { who: 'sup: s1', text: 'Waiting on sup: s1: fix the review findings on #8419' } };
  const s = statusOf(unit, { group: { isUnit: true, pr: { state: 'OPEN', isDraft: true }, activeMember: 'W-82 R3', lead } });
  assert.deepEqual([s.category, s.label, s.waiting.text], ['progress', 'Fixing review findings · W-82', 'W-82: Waiting on sup: s1: fix the review findings on #8419']);
  const own = statusOf(base({ ...unit, phase: 'awaiting_human_approval' }), { group: { isUnit: true, pr: { state: 'OPEN', isDraft: false }, lead } });
  assert.equal(own.label, 'Waiting for review / approval', 'a unit with its own lifecycle keeps its own label');
});

test('a stream pane parked at a dialog while the record has started work reaches Alex', () => {
  const s = statusOf(base({ phase: 'fixes', stream: 'sup: stream-conf-stack', assignments: [{ id: 'R3', kind: 'fixes', status: 'started' }], liveAssignments: [{ id: 'R3', kind: 'fixes', status: 'started' }], paneBlocked: 'sbx: stream-conf-stack' }));
  assert.equal(s.needs.me, true);
  assert.equal(s.waiting.who, 'you');
  assert.match(s.waiting.text, /sbx: stream-conf-stack is waiting at a prompt/);
});
