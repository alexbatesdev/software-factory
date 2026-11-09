import { test } from 'node:test';
import assert from 'node:assert/strict';
import { autoDispatchPlan } from '../core/dispatch.mjs';

const S1 = 'sup: stream-1 (support+sec)', S2 = 'sup: stream-conf-stack';
const cfg = { supervisors: { [S1]: { areas: 'PED', match: ['position end date', 'support'] }, [S2]: { areas: 'ATS', match: ['ats', 'ashby'] } }, exclude: ['W-67'], mutationBranch: 'mutation' };
// The server records a supervisor owner as the stream (ensureStream); fixtures mirror that, pinned unless a test says otherwise.
const w = (id, over = {}) => { const x = { id, title: 'Something', phase: 'ready', priority: 3, owner: S1, openQuestions: 0, openDeps: [], externalDeps: [], requests: [], assignments: [], links: {}, ...over }; const stream = [S1, S2].includes(x.owner) ? x.owner : null; return { stream, streamPin: stream ? { by: 'test' } : null, ...x }; };
const loose = (id, over = {}) => w(id, { streamPin: null, ...over });
const plan = (works, terminals = []) => Object.fromEntries(autoDispatchPlan(works, cfg, { terminals }).map(p => [p.id, p]));

test('a ready, unblocked record with an idle stream dispatches; a queued one without a request gets one', () => {
  const p = plan([w('W-1'), w('W-2', { phase: 'queued', owner: S2 })]);
  assert.deepEqual([p['W-1'].action, p['W-2'].action], ['queue', 'request']);
  assert.match(p['W-1'].reason, /no open questions/);
});

test('a stream with active work makes the next record wait its turn, one dispatch per stream', () => {
  const busy = plan([w('W-1', { phase: 'implementation' }), w('W-2')]);
  assert.match(busy['W-2'].reason, /W-1/);
  assert.equal(busy['W-2'].action, null);
  const two = plan([w('W-3', { priority: 2 }), w('W-4')]);
  assert.deepEqual([two['W-3'].action, two['W-4'].action], ['queue', null]);
  const both = plan([w('W-7', { phase: 'awaiting_human_approval', assignments: [{ kind: 'implementation', status: 'queued' }] }), w('W-8', { phase: 'fixes', assignments: [{ kind: 'fixes', status: 'started' }] }), w('W-9')]);
  assert.match(both['W-9'].reason, /busy with W-8/, 'names the job running, not one queued behind it');
  const reviewing = plan([w('W-5', { phase: 'review' }), w('W-6')]);
  assert.equal(reviewing['W-6'].action, 'queue', 'a review does not hold the worker');
});

test('questions, dependencies, external deps, holds, Mutation, trusted reviews and Terminals never dispatch', () => {
  const p = plan([
    w('W-10', { openQuestions: 1 }), w('W-11', { openDeps: ['W-9'] }), w('W-12', { externalDeps: [{ text: '#8050 merges' }] }),
    w('W-13', { intakeHold: { by: 'Alex' } }), w('W-67'),
    w('W-15', { owner: 'pr-1-trusted-review' }), w('W-16', { owner: 'sup: in-terminals' }),
  ], ['sup: in-terminals']);
  for (const [id, re] of [['W-10', /question/], ['W-11', /W-9/], ['W-12', /8050/], ['W-13', /hold/], ['W-67', /excluded/i], ['W-15', /trusted review/], ['W-16', /Terminals/]])
    assert.deepEqual([p[id].action, re.test(p[id].reason)], [null, true], `${id}: ${p[id].reason}`);
});

test('work no stream is bound to goes to the least-loaded free stream, whatever its topic', () => {
  const p = plan([w('W-1', { phase: 'review' }), w('W-2', { phase: 'queued', requests: [{ type: 'dispatch', ack: { outcome: 'received' } }] }),
    loose('W-20', { owner: null, title: 'Ashby send values' }), loose('W-21', { title: 'Position end date' })]);
  assert.deepEqual([p['W-20'].action, p['W-20'].to, p['W-20'].owner], ['queue', S2, S2]);
  assert.match(p['W-20'].reason, /least loaded/);
  assert.deepEqual([p['W-21'].action, p['W-21'].to], ['queue', S1], 'S2 took W-20 this tick, so S1 is the free one');
});

test('a never-started record leaves a busy stream for a free one', () => {
  const p = plan([w('W-1', { phase: 'implementation' }), loose('W-2', { phase: 'queued' })]);
  assert.deepEqual([p['W-2'].action, p['W-2'].to, p['W-2'].owner], ['request', S2, S2]);
});

test('pinned, already-worked and same-branch records go to their own stream, not the free one', () => {
  const worked = { assignments: [{ kind: 'implementation', status: 'done' }] };
  const p = plan([w('W-1', { phase: 'implementation' }), w('W-2'), loose('W-3', worked),
    loose('W-9', { phase: 'ready_for_human', ...worked }), loose('W-4', { owner: null, deps: ['W-9'] }), loose('W-5', { owner: null, related: [{ to: 'W-9', kind: 'same-work' }] })]);
  for (const [id, why] of [['W-2', /pinned/], ['W-3', /already worked/], ['W-4', /W-9 shares/], ['W-5', /W-9 shares/]])
    assert.deepEqual([p[id].action, /busy with W-1/.test(p[id].reason), why.test(p[id].reason)], [null, true, true], `${id}: ${p[id].reason}`);
});

test('when every stream is busy, unbound work waits', () => {
  const p = plan([w('W-1', { phase: 'implementation' }), w('W-2', { phase: 'fixes', owner: S2 }), loose('W-3')]);
  assert.equal(p['W-3'].action, null);
  assert.match(p['W-3'].reason, /every stream is busy/);
});

test('a queued record already requested or assigned is left to its supervisor', () => {
  const p = plan([w('W-30', { phase: 'queued', requests: [{ type: 'dispatch', ack: null }] }), w('W-31', { phase: 'queued', owner: S2, requests: [{ type: 'dispatch', ack: { outcome: 'received' } }] })]);
  assert.equal(p['W-30'], undefined);
  assert.equal(p['W-31'], undefined);
});

test('priority work waits only for what the stream is running, not for work queued ahead of it', () => {
  const queuedAhead = w('W-1', { phase: 'queued', assignments: [{ kind: 'implementation', status: 'queued' }], requests: [{ type: 'dispatch', ack: { outcome: 'received' } }] });
  assert.equal(plan([queuedAhead, w('W-2', { priority: 1 })])['W-2'].action, 'queue');
  assert.equal(plan([queuedAhead, w('W-3')])['W-3'].action, null, 'ordinary work still waits its turn');
  const running = w('W-1', { phase: 'implementation', assignments: [{ kind: 'implementation', status: 'started' }] });
  assert.match(plan([running, w('W-2', { priority: 1 })])['W-2'].reason, /busy with W-1/, 'it never interrupts running work');
});

// One source for queue order: a second sort on priority in the core would let the two queues disagree.
test('queue order is decided only by queueOrder in core/work.mjs', async () => {
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../core/', import.meta.url);
  const copies = readdirSync(dir).filter(f => f.endsWith('.mjs') && f !== 'work.mjs' && /priority \?\? 3/.test(readFileSync(new URL(f, dir), 'utf8')));
  assert.deepEqual(copies, []);
});

test("an internal review the stream's own worker is running holds the stream", () => {
  const c = { ...cfg, supervisors: { [S1]: { worker: 'sbx: stream-1' }, [S2]: { worker: 'sbx: stream-conf-stack' } } };
  const p = Object.fromEntries(autoDispatchPlan([w('W-1', { phase: 'rereview', assignments: [{ id: 'R3', kind: 'review', owner: 'sbx: stream-1', status: 'started' }] }), loose('W-2', { owner: null }), w('W-3')], c).map(x => [x.id, x]));
  assert.equal(p['W-3'].action, null, 'pinned to the busy stream, so it waits');
  assert.match(p['W-3'].reason, /busy with W-1/);
  assert.equal(p['W-2'].to, S2, 'unbound work goes to the free stream');
});

test('a factory record is the board developer\'s, never stream work', () => {
  const p = plan([loose('W-1', { kind: 'factory', owner: 'triage board worker' })]);
  assert.equal(p['W-1'].action, null);
  assert.match(p['W-1'].reason, /board developer/);
});

test('a record waiting on Alex holds no stream, so queued work can start there', () => {
  const p = plan([w('W-1', { phase: 'fixes', openQuestions: 2 }), w('W-2')]);
  assert.equal(p['W-2'].action, 'queue');
});

test('a worker stuck on a named blocker frees its stream for unblocked work; an unnamed block still holds it', () => {
  const stuck = waitingOn => w('W-1', { phase: 'implementation', assignments: [{ id: 'R1', kind: 'implementation', owner: S1, status: 'blocked', waitingOn }] });
  assert.equal(plan([stuck('TB-9'), w('W-2')])['W-2'].to, S1, 'parked on TB-9: the stream takes the next record');
  assert.equal(plan([stuck(null), w('W-2')])['W-2'].action, null, 'blocked with nothing named: still holds the stream');
});

test('a parked assignment resumes on its own stream once its blocker clears and the stream is free', () => {
  const parked = cleared => w('W-1', { phase: 'implementation', parked: [{ assignmentId: 'R1', waitingOn: 'W-5', cleared }], assignments: [{ id: 'R1', kind: 'implementation', owner: S1, status: 'blocked', waitingOn: 'W-5' }] });
  assert.deepEqual(['action', 'to', 'assignmentId'].map(k => plan([parked(true)])['W-1']?.[k]), ['resume', S1, 'R1']);
  assert.equal(plan([parked(false)])['W-1'], undefined, 'still waiting: nothing planned');
  assert.equal(plan([parked(true), w('W-3', { phase: 'implementation', assignments: [{ id: 'R1', kind: 'implementation', owner: S1, status: 'started' }] })])['W-1'].action, null, 'stream busy: waits its turn');
});

test('a record parked on someone, owned by a non-stream seat, or declined by a stream is not sent there (W-217, W-186 shape)', () => {
  const p = plan([
    loose('W-1', { waitingOn: { who: 'Alex', what: 'role-file edit' } }),
    loose('W-2', { owner: 'triage board worker', kind: 'build' }),
    loose('W-3', { owner: null, phase: 'queued', requests: [{ type: 'dispatch', ack: { by: S1, outcome: 'declined' } }] }),
  ]);
  assert.match(p['W-1'].reason, /waiting on Alex/); assert.equal(p['W-1'].action, null);
  assert.match(p['W-2'].reason, /triage board worker/); assert.equal(p['W-2'].action, null);
  assert.equal(p['W-3'].to, S2, 'goes to the stream that has not declined it');
});

test('a host stream takes only records in its repos; the sbx streams take everything else', () => {
  const H = 'sup: host';
  const hcfg = { ...cfg, supervisors: { ...cfg.supervisors, [H]: { repos: { 'teamwork-mini-mcp': '~/Code/repos/teamwork mini mcp' } } } };
  const p = Object.fromEntries(autoDispatchPlan([
    loose('W-1', { owner: null, repo: 'teamwork-mini-mcp' }), loose('W-2', { owner: null, repo: 'built-rails' }), loose('W-3', { owner: null }),
  ], hcfg).map(x => [x.id, x]));
  assert.equal(p['W-1'].to, H);
  assert.notEqual(p['W-2'].to, H);
  assert.notEqual(p['W-3'].to, H);
  const pinned = autoDispatchPlan([w('W-4', { owner: S1, repo: 'teamwork-mini-mcp' })], hcfg)[0];
  assert.deepEqual([pinned.action, /can't work in teamwork-mini-mcp/.test(pinned.reason)], [null, true], pinned.reason);
});

test('a host stream also takes records on the branches it names, so Mutation work runs on the host', () => {
  const H = 'sup: host';
  const hcfg = { ...cfg, mutationBranch: undefined, supervisors: { ...cfg.supervisors, [H]: { repos: { 'built-customer-implementations': '~/Code/repos/built-customer-implementations' }, branches: 'alex/(mutation-tester|test-quality/mutation-gaps)' } } };
  const p = Object.fromEntries(autoDispatchPlan([
    loose('W-1', { owner: null, repo: 'built-rails', links: { branch: 'alex/test-quality/mutation-gaps-3' } }),
    loose('W-2', { owner: null, repo: 'built-customer-implementations' }),
    loose('W-3', { owner: null, repo: 'built-rails', links: { branch: 'alex/security/graphql-mutation-id-loads' } }),
  ], hcfg).map(x => [x.id, x]));
  assert.equal(p['W-1'].to, H);
  assert.match(p['W-2'].reason, /sup: host with W-1/, 'waits for the host, never an sbx stream');
  assert.notEqual(p['W-3'].to, H);
});

import { scoutPlan, sentryCited } from '../core/scout.mjs';
const SC = { maxProposals: 3, gapHours: 6, maxUntriaged: 5, projects: ['built', 'built-rails-eu'] };
const scfg = { ...cfg, scout: SC };
const NOW = '2026-11-09T12:00:00.000Z';
const scout = (id, over = {}) => w(id, { kind: 'scout', phase: 'done', completion: { at: '2026-11-09T05:00:00.000Z' }, ...over });

test('an idle stream with nothing to dispatch gets a Sentry scout that skips issues the board already cites', () => {
  const works = [w('W-1', { phase: 'implementation' }), loose('W-2', { owner: null, phase: 'done', links: { sentry: 'https://builtapp.sentry.io/issues/6012345678/' }, updates: [{ text: 'Seen as BUILT-RAILS-EU-2K4 too' }] })];
  const p = scoutPlan(works, autoDispatchPlan(works, scfg), scfg, NOW);
  assert.equal(p.to, S2, 'the free stream, not the one building W-1');
  assert.deepEqual([p.create.kind, p.create.owner, p.create.phase, p.create.title], ['scout', S2, 'ready', 'Sentry scout 2026-11-09 12:00Z']);
  assert.match(p.create.objective, /6012345678, BUILT-RAILS-EU-2K4/);
  assert.match(p.create.objective, /built, built-rails-eu/);
  assert.match(p.create.objective, /at most 3/);
  assert.match(p.create.objective, /actually broken and actually matters/);
});

test('no scout while work dispatches, a scout is open, the last closed under 6 h ago, or 5 of its proposals wait for triage', () => {
  const none = (works, now = NOW) => scoutPlan(works, autoDispatchPlan(works, scfg), scfg, now).to;
  assert.equal(none([w('W-1')]), undefined, 'a ready record takes the stream instead');
  assert.equal(none([scout('W-1', { phase: 'queued' })]), undefined);
  assert.equal(none([scout('W-1')], '2026-11-09T10:59:00.000Z'), undefined);
  assert.equal(none([scout('W-1')]), S1);
  const proposals = n => Array.from({ length: n }, (_, i) => loose(`W-${i + 2}`, { owner: null, phase: i % 2 ? 'intake' : 'proposed', proposedFrom: 'W-1' }));
  assert.equal(none([scout('W-1'), ...proposals(5)]), undefined);
  assert.equal(none([scout('W-1'), ...proposals(4)]), S1);
});

test('a host stream never scouts: scout work is built-rails', () => {
  const H = 'sup: host';
  const hcfg = { ...scfg, supervisors: { [H]: { repos: { x: '~/x' } }, [S1]: {} } };
  const works = [w('W-1', { phase: 'implementation' })];
  assert.equal(scoutPlan(works, autoDispatchPlan(works, hcfg), hcfg, NOW).to, undefined);
});

test('a running scout never holds its stream: real work dispatches to it', () => {
  const one = { ...scfg, supervisors: { [S1]: {} } };
  const running = scout('W-1', { phase: 'queued', completion: null, requests: [{ type: 'dispatch', ack: { outcome: 'received' } }], assignments: [{ id: 'R1', kind: 'discovery', status: 'started' }] });
  const p = Object.fromEntries(autoDispatchPlan([running, w('W-2')], one).map(x => [x.id, x]));
  assert.equal(p['W-2'].action, 'queue');
  assert.equal(p['W-1'], undefined, 'the scout itself is left to finish');
});

test('Sentry citations: issue URLs in either form and short ids for the scanned projects', () => {
  assert.deepEqual(sentryCited([{ title: 'BUILT-1A2 crash', objective: 'https://sentry.io/organizations/builtapp/issues/42/ and BUILT-IN things', links: {}, updates: [] }], SC.projects), ['42', 'BUILT-1A2']);
});

test('a new PR nobody asked for waits for Alex: agent-filed build work with no PR holds until approved; Teamwork tasks and existing PRs go (Alex, 11-09)', () => {
  const p = plan([w('W-1', { kind: 'build', source: { type: 'manual' }, proposedFrom: 'W-9' }), w('W-2', { kind: 'build', source: { type: 'teamwork' }, owner: S2 }),
    w('W-3', { kind: 'pr-feedback', source: { type: 'agent', by: 'board lead' }, links: { pr: 'https://github.com/o/r/pull/1' }, streamPin: null, owner: null })]);
  assert.equal(p['W-1'].action, null); assert.match(p['W-1'].reason, /Alex's go to open a new PR/);
  assert.deepEqual([p['W-2'].action, p['W-3'].action], ['queue', 'queue']);
  assert.equal(plan([w('W-1', { kind: 'build', source: { type: 'manual' }, prApproval: { by: 'Alex (dashboard)' } })])['W-1'].action, 'queue');
  const trusted = autoDispatchPlan([w('W-4', { kind: 'build', source: { type: 'agent', by: 'local-head' } })], { ...cfg, prApproval: { trusted: ['teamwork', 'agent:local-head'] } });
  assert.equal(trusted[0].action, 'queue', 'a source in config.prApproval.trusted needs no click');
});

test("only a company repo's work needs Alex's go for a new PR; Alex's own tooling commits to main (Alex, 11-09, W-186)", () => {
  const pc = { ...cfg, prApproval: { trusted: ['teamwork'], repos: ['built-rails', 'built-customer-implementations'] } };
  const at = (repo) => autoDispatchPlan([loose('W-1', { kind: 'build', source: { type: 'agent', by: 'local-head' }, repo })], pc)[0];
  assert.equal(at('teamwork-mini-mcp').action, 'queue');
  assert.match(at('built-customer-implementations').reason, /Alex's go/);
  assert.match(at(undefined).reason, /Alex's go/, 'no repo means built-rails');
});

test('support work queues ahead of ordinary work; priority-1 work still cuts in first (Alex, 11-09)', () => {
  const order = autoDispatchPlan([loose('W-1'), loose('W-2', { support: true }), loose('W-3', { priority: 1 })], { ...cfg, supervisors: { [S1]: {} } }).filter(p => p.action).map(p => p.id);
  assert.deepEqual(order, ['W-3']);
  const two = autoDispatchPlan([loose('W-1'), loose('W-2', { support: true })], { ...cfg, supervisors: { [S1]: {} } }).filter(p => p.action).map(p => p.id);
  assert.deepEqual(two, ['W-2']);
});
