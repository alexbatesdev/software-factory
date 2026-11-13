import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAcs, derivedDeps, waitingOn } from '../core/derive.mjs';

const MD = `**Requirements**
* REQ-033: Request Changes > Job Change > Step 2.

**Acceptance criteria**
* REQ-033: The Propose New Position step shows the field to the right of Position Status, and the approved request sets it on the new position.
* REQ-034: A Request Changes form that requests position fields can include the end date, and approving it sets the value.

***FOR DEV/AGENT***: Read the approval-workflows skill first.

**Tests**
* Add or update automated tests covering the requirements above.`;

test('acceptance criteria are read verbatim from the task, in markdown or stripped HTML', () => {
  assert.deepEqual(parseAcs(MD), [
    'REQ-033: The Propose New Position step shows the field to the right of Position Status, and the approved request sets it on the new position.',
    'REQ-034: A Request Changes form that requests position fields can include the end date, and approving it sets the value.']);
  assert.deepEqual(parseAcs('Background\nstuff\nAcceptance Criteria\nREQ-1: X works.\nREQ-2: Y works.\n\nTests\nAdd tests.'), ['REQ-1: X works.', 'REQ-2: Y works.']);
  assert.deepEqual(parseAcs('**Requirements**\n* do things'), []);
  assert.deepEqual(parseAcs(''), []);
});

test('dependencies come from the task tree, PR base branches and dependency wording, each with its source', () => {
  const tasks = new Map([['tw-1', { id: 'tw-1', ref: '1', parentTaskId: 9 }], ['tw-9', { id: 'tw-9', ref: '9' }], ['tw-2', { id: 'tw-2', ref: '2', parentTaskId: 1 }]]);
  const prs = new Map([['app-10', { id: 'app-10', number: 10, repo: 'app', branch: 'a/2', base: 'a/1' }], ['app-11', { id: 'app-11', number: 11, repo: 'app', branch: 'a/1', base: 'main' }]]);
  const bySource = { 'tw-9': 'W-9', 'tw-2': 'W-2', 'app-11': 'W-11' };
  const task = derivedDeps({ key: 'tw-1', tasks, prs, bySource, texts: [{ text: 'This depends on #8050 and runs after TW 41384290.', source: 'TW 1 comment 5' }] });
  assert.deepEqual(task.map(d => [d.kind, d.ref, d.work, d.source]), [
    ['parent', 'TW 9', 'W-9', 'from TW 1 (parent task)'],
    ['child', 'TW 2', 'W-2', 'from TW 1 (subtask)'],
    ['mentioned', '#8050', null, 'from TW 1 comment 5: "depends on #8050"'],
    ['mentioned', 'TW 41384290', null, 'from TW 1 comment 5: "after TW 41384290"']]);
  assert.deepEqual(derivedDeps({ key: 'app-10', tasks, prs, bySource, texts: [] }).map(d => [d.kind, d.ref, d.work, d.source]),
    [['stacked-on', 'app#11', 'W-11', 'from PR base branch a/1']]);
});

const q = { id: 'TB-37', title: 'Approved requests and the end date value', status: 'open', verification: 'verified', options: [{ key: 'A', text: 'Set it' }], recommend: 'A' };
const w = (over = {}) => ({ id: 'W-1', phase: 'ready', links: {}, externalDeps: [], openDeps: [], requests: [], assignments: [], route: 'sup: stream-1', ...over });

test('the waiting-on line names what blocks the card and who acts', () => {
  const v = waitingOn(w({ phase: 'awaiting_human_approval', links: { pr: 'https://github.com/o/r/pull/8244' } }), { questions: [q] });
  assert.deepEqual([v.who, v.text, v.question.id], ['you', 'Waiting on you: TB-37 — Approved requests and the end date value', 'TB-37']);
  assert.match(waitingOn(w(), { questions: [{ ...q, verification: 'unverified' }] }).text, /^Waiting on verification of TB-37/);
  assert.equal(waitingOn(w({ phase: 'queued', externalDeps: [{ text: '#8050 merges, then "go build"' }] }), { questions: [] }).text, 'Waiting on #8050 merges, then "go build"');
  assert.equal(waitingOn(w({ phase: 'clarification', waitingOn: { who: 'BenC', what: 'HPMC prod IDs' } }), { questions: [] }).text, 'Waiting on BenC: HPMC prod IDs');
  assert.equal(waitingOn(w({ phase: 'awaiting_human_approval', links: { pr: 'https://github.com/o/r/pull/8244' } }), { questions: [] }).text, 'Waiting for 1 QA + 1 dev approval on #8244');
  assert.equal(waitingOn(w({ phase: 'awaiting_alex_review', links: { pr: 'https://github.com/o/r/pull/8356' } }), { questions: [] }).text, 'Waiting on you: read the trusted review and submit your own review of #8356');
  assert.equal(waitingOn(w({ phase: 'queued', route: null }), { questions: [] }).text, 'Waiting for an owner: no stream supervisor is set');
  assert.equal(waitingOn(w({ openDeps: ['W-9'] }), { questions: [] }).text, 'Waiting on W-9 to finish');
  assert.equal(waitingOn(w({ phase: 'done' }), { questions: [q] }), null);
});

import { parentContext } from '../core/derive.mjs';
test('triage sees the parent task before asking, so it does not ask what the epic already says', () => {
  const parents = new Map([['tw-41073645', { id: 'tw-41073645', ref: '41073645', title: 'Ashby integration', description: 'Integrate the app with Ashby: import and send reqs.' }]]);
  const p = parentContext({ parentTaskId: 41073645 }, parents);
  assert.match(p, /Parent task TW 41073645: "Ashby integration"/);
  assert.match(p, /import and send reqs/);
  assert.equal(parentContext({ parentTaskId: null }, parents), '');
});

test('a PR past internal review waits on the board to mark it ready, and on Alex only when that attempt failed', () => {
  const w = { id: 'W-1', phase: 'ready_for_human', head: 'aaa', links: { pr: 'https://github.com/acme-org/app/pull/5' }, prReadyOps: [] };
  assert.equal(waitingOn(w, { questions: [] }).who, 'board');
  const failed = { ...w, prReadyOps: [{ id: 'P1', head: 'aaa', status: 'failed' }] };
  assert.match(waitingOn(failed, { questions: [] }).text, /^Waiting on you: marking #5 ready was failed/);
});

test('an approval wait with our own fixes queued says the fixes come first', () => {
  const v = waitingOn(w({ phase: 'awaiting_human_approval', links: { pr: 'https://github.com/o/r/pull/8245' }, assignments: [{ id: 'R1', kind: 'fixes', status: 'queued' }] }), { questions: [] });
  assert.equal(v.text, 'Waiting on the stream: R1 fixes queued on #8245, then 1 QA + 1 dev approval');
});

test('a pane parked at a prompt outranks an answer still waiting for its ack', () => {
  const answered = { id: 'TB-9', status: 'answered', title: 'Pick', answer: { choice: 'a', sentTo: 'sup: stream-1', ackAsked: true } };
  const w = { phase: 'fixes', stream: 'sup: stream-1', assignments: [], paneBlocked: 'sbx: stream-1' };
  assert.equal(waitingOn(w, { questions: [answered] }).who, 'you');
  assert.match(waitingOn({ ...w, paneBlocked: null }, { questions: [answered] }).text, /TB-9.*not acknowledged/);
});

test('a queued card carries what its stream is held by', () => {
  const w = { phase: 'awaiting_human_approval', stream: 'sup: s1', links: { pr: 'https://github.com/o/r/pull/8236' }, assignments: [{ id: 'R2', kind: 'fixes', status: 'queued' }], queueHold: 'behind W-82 R5 (started)' };
  assert.match(waitingOn(w).text, /R2 fixes queued on #8236 behind W-82 R5 \(started\), then/);
  assert.match(waitingOn({ ...w, phase: 'queued', route: 'sup: s1', assignments: [], queueHold: 'sbx: s1 is working' }).text, /start the brief \(sbx: s1 is working\)/);
});
