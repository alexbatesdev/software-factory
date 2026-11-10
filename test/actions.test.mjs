import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandsFor } from '../core/actions.mjs';
import { ACTIONS, refusal } from '../core/capabilities.mjs';

// Events only the factory itself may produce (GitHub readers, Alex's own routes); no board action may mint one.
const GATE_EVENTS = ['mark_ready', 'merged', 'authorize_pr_ready', 'pr_ready_op', 'waive_internal_review', 'retro_close', 'transition', 'alex_review_seen', 'hold_released'];
const sample = { ref: 'W-1/R1', work: 'W-1', assignmentId: 'R1', kind: 'implementation', status: 'queued', head: 'abc1234', result: 'clean', id: 'TB-1', to: 'sup', owner: 'sup', title: 't', text: 't', type: 'mark_ready', pr: 'https://github.com/o/r/pull/1', bucket: 'ready', into: 'W-2', note: 'n', evidence: 'e', findingId: 'F1', id: 'TB-1', wwbd: 'w' };

test('no board action can mint a gate event, even when asked to by name', () => {
  for (const action of ACTIONS.filter(a => a !== 'read')) {
    for (const c of commandsFor(action, action === 'settle_finding' ? { ...sample, status: 'resolved' } : sample)) {
      assert.ok(!['import', 'absorb'].includes(c.kind), `${action} emits ${c.kind}`);
      if (c.kind === 'event') assert.ok(!GATE_EVENTS.includes(c.payload.type), `${action} emits ${c.payload.type}`);
    }
  }
});

test('merge and raw event writes are not actions for any role', () => {
  for (const a of ['merge', 'merged', 'event', 'mark_ready']) assert.match(refusal('board-developer', a), /not a board action/);
});

test('a blocked report carries what it waits on to the board', () => {
  const [c] = commandsFor('progress', { work: 'W-1', assignmentId: 'R1', expectedVersion: 2, stage: 'blocked', waitingOn: 'TB-9', text: 'x' });
  assert.equal(c.payload.waitingOn, 'TB-9');
});

test('a discovery with no text describing the finding is refused', () => {
  assert.throws(() => commandsFor('progress', { work: 'W-1', discovery: 'CreateEntitiesTool assigns json_form_values directly' }), /text/);
});

test('a progress note naming a discovery proposes it as its own record', () => {
  const [c] = commandsFor('progress', { work: 'W-1', discovery: 'Export URL breaks on a query string', text: 'ExportForm appends ?full_data=1' });
  assert.deepEqual(c.payload, { type: 'discovery', text: 'Export URL breaks on a query string', objective: 'ExportForm appends ?full_data=1' });
});

test('a record nobody started can be withdrawn with a reason; started work cannot', async () => {
  const { createWork, applyEvent } = await import('../core/work.mjs');
  const ctx = { now: '2026-11-06T18:00:00Z', by: 'dev' };
  const [c] = commandsFor('withdraw', { work: 'W-1', note: 'trusted reviews run off the board (CLAUDE.md:9)' });
  const w = applyEvent(createWork({ id: 'W-1', title: 'Trusted review #8551' }, ctx), c.payload, ctx).work;
  assert.deepEqual([w.phase, w.completion.withdrawn], ['cancelled', 'trusted reviews run off the board (CLAUDE.md:9)']);
  const started = { ...createWork({ id: 'W-2', title: 'x' }, ctx), assignments: [{ id: 'R1', status: 'started' }] };
  assert.throws(() => applyEvent(started, c.payload, ctx), /started/);
});

test('triage can set the repo a record works in, so a host-repo record reaches its host stream (W-233)', () => {
  const cmds = commandsFor('triage', { work: 'W-1', bucket: 'ready', repo: 'teamwork-mini-mcp' });
  assert.deepEqual(cmds[0], { kind: 'update', target: 'W-1', payload: { repo: 'teamwork-mini-mcp' } });
});

test('triage untilMerged holds the record on those PRs', () => {
  const cs = commandsFor('triage', { work: 'W-1', bucket: 'intake', note: 'held', untilMerged: '#8606, https://github.com/o/r/pull/9' });
  assert.deepEqual(cs.at(-1), { kind: 'event', target: 'W-1', payload: { type: 'hold', prs: ['#8606', 'https://github.com/o/r/pull/9'] } });
  assert.throws(() => commandsFor('triage', { work: 'W-1', bucket: 'intake', untilMerged: 'when 8606 lands' }), /untilMerged/);
});

test('triage close withdraws a record with its reason, and needs one', () => {
  assert.deepEqual(commandsFor('triage', { work: 'W-284', bucket: 'close', reason: 'duplicate', of: 'W-278', note: 'same Teamtailor/Ashby cleanup' }),
    [{ kind: 'event', target: 'W-284', payload: { type: 'withdraw', note: 'Duplicate of W-278: same Teamtailor/Ashby cleanup', duplicateOf: 'W-278' } }], 'the duplicate names its record, so its source key moves there (W-365)');
  assert.throws(() => commandsFor('triage', { work: 'W-1', bucket: 'close', reason: 'meh', note: 'x' }), /reason/);
  assert.throws(() => commandsFor('triage', { work: 'W-1', bucket: 'close', reason: 'duplicate', note: 'x' }), /of/);
});

test('a question names the WWBD passage it checked, or that none applies, and keeps it for Alex', () => {
  assert.throws(() => commandsFor('ask', { title: 'Which rule?', promptedBy: 'x' }), /wwbd/);
  const [c] = commandsFor('ask', { title: 'Which rule?', promptedBy: 'x', wwbd: 'no passage applies: a product rule' });
  assert.equal(c.payload.wwbd, 'no passage applies: a product rule');
});

test('triage untilAnswered holds the record on a question, and the release clears only that hold', async () => {
  const { applyEvent, createWork } = await import('../core/work.mjs');
  const cs = commandsFor('triage', { work: 'W-1', bucket: 'intake', note: 'held', untilAnswered: 'TB-176' });
  assert.deepEqual(cs.at(-1).payload, { type: 'hold', questions: ['TB-176'] });
  assert.throws(() => commandsFor('triage', { work: 'W-1', bucket: 'intake', untilAnswered: 'the ATS question' }), /untilAnswered/);
  const c = { now: '2026-11-09T21:00:00.000Z', by: 'board lead' };
  let w = applyEvent(createWork({ id: 'W-1', title: 'x' }, c), { type: 'hold', prs: ['#1'] }, c).work;
  w = applyEvent(w, { type: 'hold', questions: ['TB-176'] }, c).work;
  assert.deepEqual(w.externalDeps.map(d => d.ref), ['#1', 'TB-176']);
  w = applyEvent(w, { type: 'hold_released', question: 'TB-176' }, c).work;
  assert.deepEqual(w.externalDeps.map(d => d.ref), ['#1']);
});

test('triage releaseHold clears a settled hold by its text, so a free-text hold from before W-292 can be cleared', async () => {
  const { applyEvent, createWork } = await import('../core/work.mjs');
  const cs = commandsFor('triage', { work: 'W-3', bucket: 'ready', note: 'Alex released it (TB-188 a)', releaseHold: '#8050 merges, then "go build" from code-e1' });
  assert.deepEqual(cs.at(-1).payload, { type: 'hold_released', text: '#8050 merges, then "go build" from code-e1' });
  const c = { now: '2026-11-09T22:00:00.000Z', by: 'board lead' };
  const w = applyEvent(createWork({ id: 'W-3', title: 'x', externalDeps: [{ text: '#8050 merges, then "go build" from code-e1' }, { text: 'other' }] }, c), cs.at(-1).payload, c).work;
  assert.deepEqual(w.externalDeps, [{ text: 'other' }]);
  assert.throws(() => applyEvent(w, cs.at(-1).payload, c), /no hold/);
});

test('triage carries a new-PR breakdown as its own event (Alex, 11-09)', async () => {
  const { applyEvent, createWork } = await import('../core/work.mjs');
  const proposal = { prompted: 'A worker review of #8631', addresses: 'iCIMS send drops row keys', whyThisFix: 'One guard where all callers route', since: 'Since #8402 (2026-09-14)', customerImpact: 'None: same payload for valid rows' };
  const cs = commandsFor('triage', { work: 'W-1', bucket: 'ready', note: 'n', proposal });
  assert.deepEqual(cs.at(-1).payload, { type: 'proposal', ...proposal });
  assert.throws(() => commandsFor('triage', { work: 'W-1', bucket: 'ready', proposal: { prompted: 'x' } }), /addresses, whyThisFix, since, customerImpact/);
  const c = { now: '2026-11-09T23:00:00.000Z', by: 'board lead' };
  assert.deepEqual(applyEvent(createWork({ id: 'W-1', title: 'x' }, c), cs.at(-1).payload, c).work.proposal, { ...proposal, by: 'board lead', at: c.now });
});

test('a free-text wait names its actor (alex or other); a typed reference needs none (W-317 phase 1)', () => {
  assert.throws(() => commandsFor('progress', { work: 'W-1', waitingOn: 'Alex running the replica EXPLAIN', text: 'x' }), /actor: "alex" or "other"/);
  assert.deepEqual(commandsFor('progress', { work: 'W-1', waitingOn: 'product and design', actor: 'other', text: 'x' }).at(-1).payload, { type: 'wait', who: 'product and design', what: 'x', evidence: 'x', actor: 'other' });
  assert.equal(commandsFor('progress', { work: 'W-1', assignmentId: 'R1', stage: 'blocked', waitingOn: 'TB-9', text: 'x' }).at(-1).payload.actor, undefined);
  assert.equal(commandsFor('progress', { work: 'W-1', assignmentId: 'R1', stage: 'blocked', waitingOn: 'run the EXPLAIN on the replica', actor: 'alex', text: 'x' }).at(-1).payload.actor, 'alex');
  assert.throws(() => commandsFor('progress', { work: 'W-1', assignmentId: 'R1', stage: 'blocked', waitingOn: 'TB-9', actor: 'bob' }), /actor: "alex" or "other"/);
});

test('a hold with no release condition carries a review date and who reviews it, or names who it is deferred to (W-317 phase 4)', async () => {
  const { openStore } = await import('../core/store.mjs');
  const cs = commandsFor('triage', { work: 'W-1', bucket: 'intake', note: 'parked', reviewBy: '2026-11-16', reviewer: 'board lead' });
  assert.deepEqual(cs.at(-1).payload, { type: 'hold', review: { by: '2026-11-16', reviewer: 'board lead' } });
  assert.throws(() => commandsFor('triage', { work: 'W-1', bucket: 'intake', reviewBy: 'next week', reviewer: 'board lead' }), /reviewBy/);
  assert.throws(() => commandsFor('triage', { work: 'W-1', bucket: 'intake', reviewBy: '2026-11-16' }), /reviewer/);
  assert.deepEqual(commandsFor('triage', { work: 'W-1', bucket: 'intake', note: 'n', deferredTo: 'product' }).at(-1).payload, { type: 'hold', deferred: 'product' });
  const s = openStore(':memory:'), c = { now: '2026-11-09T23:59:00.000Z', by: 'test' };
  const id = s.append({ kind: 'create', payload: { title: 'Parked' } }, c).id;
  s.appendAll(commandsFor('triage', { work: id, bucket: 'intake', note: 'n', reviewBy: '2026-11-16', reviewer: 'board lead' }), c);
  s.appendAll(commandsFor('triage', { work: id, bucket: 'intake', note: 'n', deferredTo: 'product' }), c);
  assert.deepEqual(s.state.work[id].externalDeps.map(d => d.text), ['review by 2026-11-16 (board lead)', 'deferred to product']);
});
