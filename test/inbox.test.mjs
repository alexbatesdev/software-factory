import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { inboxCommands } from '../core/inbox.mjs';

const S1 = 'sup: stream-1', R = 'questions router';
const cfg = { supervisors: [S1], seats: [S1, R, 'local-head'], router: R };
const ctx = (by = 'test') => ({ now: '2026-10-30T19:00:00.000Z', by });
const work = (over = {}) => ({ id: 'W-1', title: 'Fix it', phase: 'queued', stream: S1, head: null, requests: [{ id: 'R1', type: 'dispatch', at: 'x', ack: null }], assignments: [], updates: [], ...over });
const store = (state = {}) => {
  const s = openStore();
  for (const [c, recs] of Object.entries(state)) for (const [k, v] of Object.entries(recs)) s.append({ kind: 'import', target: `${c}/${k}`, payload: v }, ctx('import'));
  return s;
};
const plan = (s, fleet) => inboxCommands(s.state, cfg, fleet);

test('each open request is messaged to its stream once, and never again after V1 already told it', () => {
  const s = store({ work: { 'W-1': work() } });
  const [c] = plan(s).cmds;
  assert.deepEqual([c.payload.to, c.payload.about], [S1, { requests: 'W-1/R1' }]);
  s.append(c, ctx('board'));
  assert.deepEqual(plan(s).cmds, []);
  const v1 = store({ work: { 'W-1': work() }, notifications: { 'N-1': { status: 'submitted', requests: ['W-1/R1'] } } });
  assert.deepEqual(plan(v1).cmds, [], 'a V1 notice counts as told');
  const shadow = store({ work: { 'W-1': work() }, notifications: { 'N-1': { status: 'submitted', at: '2026-10-31', requests: ['W-1/R1'] } } });
  assert.equal(inboxCommands(shadow.state, { ...cfg, v1Before: '2026-10-30' }).cmds.length, 1, 'shadow decides for itself after it started');
});

test("an answer goes to the router's pick, else a seat that asked, else the record's stream, else the router", () => {
  const answered = (from, extra = {}) => ({ status: 'answered', from, work: 'W-1', answer: { choice: 'a', at: 'z', ...extra } });
  const s = store({ work: { 'W-1': work({ requests: [] }), 'W-2': work({ id: 'W-2', stream: null, requests: [] }) },
    questions: { 'TB-1': answered('local-head'), 'TB-2': answered('reaped pane'), 'TB-3': { ...answered('reaped pane'), work: 'W-2' }, 'TB-4': answered('local-head', { routeTo: S1 }) } });
  const to = Object.fromEntries(plan(s).cmds.reverse().map(c => [c.payload.about.answers, c.payload.to])); // the first message per answer
  assert.deepEqual(to, { 'TB-1': 'local-head', 'TB-2': S1, 'TB-3': R, 'TB-4': S1 });
});

test("an answer asked by another seat also reaches the record's owner, once (W-243: TB-158 went to local-head only)", () => {
  const s = store({ work: { 'W-1': work({ requests: [] }) }, questions: { 'TB-1': { status: 'answered', from: 'local-head', work: 'W-1', answer: { choice: 'a', at: 'z' } } } });
  assert.deepEqual(plan(s).cmds.map(c => c.payload.to).sort(), ['local-head', S1].sort());
  for (const c of plan(s).cmds) s.append(c, ctx('board'));
  assert.deepEqual(plan(s).cmds, []);
});

test('a worker that stops with a started assignment messages its supervisor once', () => {
  const s = store({ work: { 'W-1': work({ phase: 'implementation', requests: [], assignments: [{ id: 'R1', kind: 'implementation', status: 'started', version: 1 }] }) } });
  const unit = status => ({ id: 'u1', supervisor: { label: S1, status: 'idle' }, worker: { label: 'sbx: stream-1', status } });
  let { watches } = plan(s, { units: [unit('working')], now: 0 });
  ({ watches } = plan(s, { units: [unit('idle')], now: 1000, watches }));
  const due = plan(s, { units: [unit('idle')], now: 120000, watches });
  assert.deepEqual(due.cmds.map(c => c.payload.about), [{ workerStop: 'W-1/R1' }]);
});

test('a worker that stops again on the same assignment messages its supervisor again', () => {
  const s = store({ work: { 'W-1': work({ phase: 'implementation', requests: [], assignments: [{ id: 'R1', kind: 'implementation', status: 'started', version: 1 }] }) } });
  const unit = status => ({ id: 'u1', supervisor: { label: S1, status: 'idle' }, worker: { label: 'sbx: stream-1', status } });
  let watches, t = 0, sent = 0;
  for (const status of ['working', 'idle', 'idle', 'working', 'idle', 'idle']) {
    const p = plan(s, { units: [unit(status)], now: t += 70000, watches });
    watches = p.watches;
    for (const c of p.cmds) { s.append(c, { now: 'z', by: 'board' }); sent++; }
  }
  assert.equal(sent, 2);
});

test('a worker reported working whose pane has not changed for quietMs messages its supervisor once per stretch', () => {
  const s = store({ work: { 'W-1': work({ phase: 'review', requests: [], assignments: [{ id: 'R3', kind: 'review', owner: 'sbx: stream-1', status: 'started', version: 1 }] }) } });
  const unit = { id: 'u1', supervisor: { label: S1, status: 'idle' }, worker: { label: 'sbx: stream-1', status: 'working' } };
  const q = quietSince => plan(s, { units: [unit], now: 40 * 60000, quiet: { u1: quietSince } }).cmds.filter(c => c.payload.about.quietWorker);
  assert.deepEqual(q(20 * 60000), [], 'quiet for 20 minutes is not yet stuck');
  const [c] = q(0);
  assert.deepEqual([c.payload.to, c.payload.about], [S1, { quietWorker: 'W-1/R3/0' }]);
  s.append(c, ctx('board'));
  assert.deepEqual(q(0), [], 'told once for this quiet stretch');
});

test('the board lead gets one check-in message per hour', () => {
  const s = store({});
  const at = iso => inboxCommands(s.state, { ...cfg, checkIn: { seat: 'board lead', now: iso } }).cmds;
  const [c] = at('2026-11-05T09:10:00.000Z');
  assert.deepEqual([c.payload.to, c.payload.about], ['board lead', { checkIn: '2026-11-05T09' }]);
  s.append(c, ctx('board'));
  assert.deepEqual(at('2026-11-05T09:50:00.000Z'), []);
  assert.equal(at('2026-11-05T10:00:00.000Z').length, 1);
});

test('a record that lands in intake after intakeSince messages the triage seat once', () => {
  const s = store({ work: { 'W-1': work({ phase: 'intake', requests: [], createdAt: '2026-11-05T09:00:00.000Z' }), 'W-2': work({ id: 'W-2', phase: 'intake', requests: [], createdAt: '2026-11-01T09:00:00.000Z' }) } });
  const c = { ...cfg, triage: { seat: 'board lead', since: '2026-11-05T00:00:00.000Z' } };
  const cmds = inboxCommands(s.state, c).cmds.filter(x => x.payload.about.intake);
  assert.deepEqual(cmds.map(x => [x.payload.to, x.payload.about.intake]), [['board lead', 'W-1']]);
  s.append(cmds[0], ctx('board'));
  assert.deepEqual(inboxCommands(s.state, c).cmds.filter(x => x.payload.about.intake), []);
});

test('a proposed record created after intakeSince also messages the triage seat', () => {
  const s = store({ work: { 'W-1': work({ phase: 'proposed', requests: [], createdAt: '2026-11-05T09:00:00.000Z' }) } });
  const cmds = inboxCommands(s.state, { ...cfg, triage: { seat: 'board lead', since: '2026-11-05T00:00:00.000Z' } }).cmds.filter(x => x.payload.about.intake);
  assert.deepEqual(cmds.map(x => x.payload.about.intake), ['W-1']);
});

test('a draining stream tells its supervisor once per sandbox, and gets no idle-queue wake', () => {
  const s = store({ work: { 'W-1': work({ phase: 'fixes', requests: [], assignments: [{ id: 'R2', kind: 'fixes', status: 'queued', version: 1 }] }) } });
  const unit = { id: 'u1', supervisor: { label: S1, status: 'idle' }, worker: { label: 'sbx: stream-1', status: 'idle', sandbox: 'box-1' } };
  const fleet = now => ({ units: [unit], now, watches: {}, drain: new Map([[S1, 'sbx: stream-1 disk at 95%: recycled after its running job']]) });
  const first = inboxCommands(s.state, cfg, fleet(0)).cmds;
  assert.deepEqual(first.map(c => c.payload.about), [{ recycle: 'sbx: stream-1/box-1' }]);
  s.append(first[0], ctx('board'));
  assert.deepEqual(inboxCommands(s.state, cfg, fleet(10 * 60000)).cmds, [], 'no repeat, and no idle-queue wake while draining');
});

test('an idle non-stream seat that owns ready records gets a nudge from the inbox planner', async () => {
  const { inboxCommands } = await import('../core/inbox.mjs');
  const state = { work: { 'W-9': { id: 'W-9', title: 'Fix it', phase: 'ready', stream: 'dev', requests: [] } }, questions: {}, messages: {}, notifications: {} };
  const fleet = now => ({ units: [], others: [{ label: 'dev', status: 'idle' }], now, watches });
  let watches = {};
  let r = inboxCommands(state, { supervisors: [], seats: ['dev'] }, fleet(0)); watches = r.watches;
  r = inboxCommands(state, { supervisors: [], seats: ['dev'] }, fleet(600000));
  assert.deepEqual(r.cmds.map(c => [c.payload.to, c.payload.work]), [['dev', 'W-9']]);
});

test('a started assignment whose owner has no pane is flagged to the board lead once', async () => {
  const { inboxCommands } = await import('../core/inbox.mjs');
  const work = { id: 'W-129', title: 'Trusted review #8434', phase: 'rereview', requests: [], assignments: [{ id: 'R-1', kind: 'review', owner: 'trusted-review-8434', status: 'started', version: 1 }] };
  const state = { work: { 'W-129': work }, questions: {}, messages: {}, notifications: {} };
  const cfg = { supervisors: [], seats: ['board lead'], triage: { seat: 'board lead' } };
  const fleet = { units: [], others: [{ label: 'board lead', status: 'working' }], now: 0, watches: {} };
  const r = inboxCommands(state, cfg, fleet);
  const flags = r.cmds.filter(c => c.payload.about?.ghost);
  assert.deepEqual(flags.map(c => [c.payload.to, c.payload.work, c.payload.about.ghost]), [['board lead', 'W-129', 'W-129/R-1/v1']]);
  state.messages['M-1'] = { id: 'M-1', to: 'board lead', about: { ghost: 'W-129/R-1/v1' } };
  assert.equal(inboxCommands(state, cfg, fleet).cmds.filter(c => c.payload.about?.ghost).length, 0, 'once');
  assert.equal(inboxCommands(state, cfg, { ...fleet, others: [...fleet.others, { label: 'trusted-review-8434', status: 'working' }] }).cmds.filter(c => c.payload.about?.ghost).length, 0, 'not while the pane exists');
  delete state.messages['M-1']; work.phase = 'done';
  assert.equal(inboxCommands(state, cfg, fleet).cmds.filter(c => c.payload.about?.ghost).length, 0, 'a finished record is never flagged: it takes no events');
});

test("a worker's own board note reaches its supervisor once, so nobody has to read the worker's pane", async () => {
  const { inboxCommands } = await import('../core/inbox.mjs');
  const work = { id: 'W-5', title: 'Fix it', phase: 'implementation', stream: 'sup: s1', requests: [], assignments: [],
    updates: [{ at: 't0', by: 'sup: s1', text: 'Briefed.' }, { at: 't1', by: 'sbx: s1', text: 'Done: PR #9 pushed at abc1234, internal review clean.' }] };
  const state = { work: { 'W-5': work }, questions: {}, messages: {}, notifications: {} };
  const cfg = { supervisors: ['sup: s1'], seats: [], workers: { 'sbx: s1': 'sup: s1' } };
  const notes = r => r.cmds.filter(c => c.payload.about?.workerNote);
  const first = notes(inboxCommands(state, cfg));
  assert.deepEqual(first.map(c => [c.payload.to, c.payload.work, c.payload.about.workerNote]), [['sup: s1', 'W-5', 'W-5/1']]);
  assert.match(first[0].payload.text, /PR #9 pushed at abc1234/);
  state.messages['M-1'] = { id: 'M-1', to: 'sup: s1', about: { workerNote: 'W-5/1' } };
  assert.equal(notes(inboxCommands(state, cfg)).length, 0, 'once');
});

test("a record owned by the board developer reaches its pane when it's filed, and again when someone else adds a note", async () => {
  const { inboxCommands } = await import('../core/inbox.mjs');
  const rec = (id, extra = {}) => ({ id, title: `Bug ${id}`, phase: 'ready', stream: 'dev', requests: [], assignments: [], updates: [{ at: '2026-11-06T00:00:00Z', by: 'board lead', text: 'Created.' }], ...extra });
  const state = { work: { 'W-1': rec('W-1'), 'W-2': rec('W-2', { waitingOn: { who: 'Alex' } }), 'W-3': rec('W-3', { phase: 'done' }) }, questions: {}, messages: {}, notifications: {} };
  const cfg = { supervisors: [], seats: ['dev'], developer: 'dev', developerSince: '2026-11-05T23:00:00Z' };
  const dev = r => r.cmds.filter(c => c.payload.to === 'dev' && (c.payload.about?.devRecord || c.payload.about?.devNote)).map(c => Object.values(c.payload.about)[0]);
  assert.deepEqual(dev(inboxCommands(state, cfg)), ['W-1'], 'open and unparked only');
  const owned = { ...state, work: { 'W-4': rec('W-4', { stream: undefined, owner: 'dev' }) } };
  assert.deepEqual(dev(inboxCommands(owned, cfg)), ['W-4'], 'owner alone is enough (W-239 was created with an owner and no stream)');
  state.messages['M-1'] = { id: 'M-1', to: 'dev', about: { devRecord: 'W-1' }, at: '2026-11-06T00:01:00Z' };
  state.work['W-1'].updates.push({ at: '2026-11-06T00:00:30Z', by: 'board lead', text: 'Updated owner, stream.' }, { at: '2026-11-06T00:05:00Z', by: 'board lead', text: 'Second instance.' }, { at: '2026-11-06T00:06:00Z', by: 'dev', text: 'mine' });
  assert.deepEqual(dev(inboxCommands(state, cfg)), ['W-1/2'], "someone else's note after the notice; not the record's setup, not the developer's own");
});

test("a worker job with no note from the worker 10 minutes after it started tells the supervisor once (W-218: no board tools in the session)", async () => {
  const { inboxCommands } = await import('../core/inbox.mjs');
  const job = (id, extra = {}) => ({ id, title: id, phase: 'implementation', stream: 'sup: s1', requests: [], updates: [{ at: '2026-11-06T18:00:00Z', by: 'sup: s1', text: 'Briefed.' }],
    assignments: [{ id: 'R1', kind: 'implementation', status: 'started', owner: 'sup: s1', history: [{ status: 'started', at: '2026-11-06T18:00:00Z' }] }], ...extra });
  const state = { work: { 'W-1': job('W-1'), 'W-2': job('W-2') }, questions: {}, messages: {}, notifications: {} };
  state.work['W-2'].updates.push({ at: '2026-11-06T18:03:00Z', by: 'sbx: s1', text: 'Started on branch b.' });
  const cfg = { supervisors: ['sup: s1'], seats: [], workers: { 'sbx: s1': 'sup: s1' }, workerSilentSince: '2026-11-06T17:00:00Z' };
  const silent = now => inboxCommands(state, { ...cfg, now }).cmds.filter(c => c.payload.about?.workerSilent).map(c => [c.payload.to, c.payload.about.workerSilent]);
  assert.deepEqual(silent('2026-11-06T18:09:00Z'), [], 'inside the grace');
  assert.deepEqual(silent('2026-11-06T18:11:00Z'), [['sup: s1', 'W-1/R1']]);
  state.messages['M-1'] = { id: 'M-1', to: 'sup: s1', about: { workerSilent: 'W-1/R1' } };
  assert.deepEqual(silent('2026-11-06T18:30:00Z'), [], 'once');
});

test('a host stream request points its supervisor at the host-stream how-to (TB-159)', () => {
  const s = store({ work: { 'W-1': work() } });
  const [c] = inboxCommands(s.state, { ...cfg, hostHowTo: { [S1]: '/x/host-streams.md' } }).cmds;
  assert.match(c.payload.text, /Host stream: spawn this job's worker per \/x\/host-streams\.md/);
});

test('a building record acked "received" with nothing assigned for 15 min nudges its supervisor once to assign or park it (W-263: W-224 R4)', () => {
  const fixes = work({ phase: 'fixes', requests: [{ id: 'R4', type: 'fixes', at: 'x', ack: { outcome: 'received', at: '2026-11-06T23:34:00.000Z' } }] });
  const s = store({ work: { 'W-1': fixes } });
  const held = c => inboxCommands(s.state, { ...cfg, now: c }).cmds.filter(x => x.payload.about?.heldIdle);
  assert.equal(held('2026-11-06T23:40:00.000Z').length, 0, 'not before the grace');
  const [c] = held('2026-11-06T23:50:00.000Z');
  assert.deepEqual([c.payload.to, c.payload.about], [S1, { heldIdle: 'W-1/R4' }]);
  assert.match(c.payload.text, /park it/);
  s.append(c, ctx('board'));
  assert.equal(held('2026-11-06T23:59:00.000Z').length, 0, 'once');
  const assigned = store({ work: { 'W-1': { ...fixes, assignments: [{ id: 'R5', kind: 'fixes', status: 'started' }] } } });
  assert.equal(inboxCommands(assigned.state, { ...cfg, now: '2026-11-06T23:50:00.000Z' }).cmds.filter(x => x.payload.about?.heldIdle).length, 0, 'assigned work is not held idle');
  const parkedRec = store({ work: { 'W-1': { ...fixes, assignments: [{ id: 'R5', kind: 'fixes', status: 'blocked', waitingOn: 'TB-1' }] } } });
  assert.equal(inboxCommands(parkedRec.state, { ...cfg, now: '2026-11-06T23:50:00.000Z' }).cmds.filter(x => x.payload.about?.heldIdle).length, 0, 'parked work already frees the stream');
});

test('an intake notice names an open record citing the same file within 15 lines as a likely duplicate (W-269: W-267/W-258, W-268/W-232)', () => {
  const at = '2026-11-07T00:00:00.000Z';
  const s = store({ work: {
    'W-232': work({ id: 'W-232', phase: 'awaiting_human_approval', objective: 'habtm ids (app/models/company_document.rb:35-37)' }),
    'W-9': work({ id: 'W-9', phase: 'done', objective: 'icims_helpers.rb:97' }),
    'W-270': work({ id: 'W-270', phase: 'ready', kind: 'factory', objective: 'evidence: company_document.rb:35-37' }),
    'W-268': work({ id: 'W-268', phase: 'intake', createdAt: at, requests: [], objective: 'HABTM (company_document.rb:35-37) and controller.rb:116' }),
    'W-269': work({ id: 'W-269', phase: 'intake', createdAt: at, requests: [], objective: 'company_document.rb:90 is unrelated' }),
  } });
  const notes = Object.fromEntries(inboxCommands(s.state, { ...cfg, triage: { seat: 'board lead', since: '2026-11-05T00:00:00.000Z' } }).cmds
    .filter(x => x.payload.about.intake).map(x => [x.payload.about.intake, x.payload.text]));
  assert.match(notes['W-268'], /Likely duplicate of W-232 \(company_document\.rb:35\):/, 'a factory record quoting the lines is not a duplicate');
  assert.doesNotMatch(notes['W-269'], /duplicate/);
});

test("the board's own bookkeeping lines under a worker's name aren't relayed as worker notes", async () => {
  const { inboxCommands } = await import('../core/inbox.mjs');
  const updates = ['Updated links.', 'Proposed from W-4.', 'Out-of-scope discovery proposed as separate work: HCP CSV omits a date', 'R2 done: PR #9 at abc1234'].map((text, i) => ({ at: `t${i}`, by: 'sbx: s1', text }));
  const state = { work: { 'W-5': { id: 'W-5', title: 'Fix it', phase: 'implementation', stream: 'sup: s1', requests: [], assignments: [], updates } }, questions: {}, messages: {}, notifications: {} };
  const notes = inboxCommands(state, { supervisors: ['sup: s1'], seats: [], workers: { 'sbx: s1': 'sup: s1' } }).cmds.filter(c => c.payload.about?.workerNote);
  assert.deepEqual(notes.map(c => c.payload.about.workerNote), ['W-5/3']);
});

test('an fyi message is stored already acked, so it never counts as unread or wakes a seat', async () => {
  const { openStore } = await import('../core/store.mjs');
  const s = openStore(':memory:');
  s.append({ kind: 'message', payload: { to: 'sup: s1', about: { restarted: 'x', fyi: true }, text: 'restarted' } }, { now: 't', by: 'board' });
  assert.equal(Object.values(s.state.messages)[0].ackedAt, 't');
});
