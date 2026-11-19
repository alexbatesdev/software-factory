import { DEFAULT_REPO } from '../core/work.mjs';
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
  assert.equal(p['W-21'].action, null, 'S2 took W-20 this tick, and S1 holds W-2, acked and about to start (W-554)');
});

test('a never-started record leaves a busy stream for a free one', () => {
  const p = plan([w('W-1', { phase: 'implementation' }), loose('W-2', { phase: 'queued' })]);
  assert.deepEqual([p['W-2'].action, p['W-2'].to, p['W-2'].owner], ['request', S2, S2]);
});

test('pinned records and records sharing a branch with a live job go to their own stream; one only worked there before goes to the free one (W-505)', () => {
  const worked = { assignments: [{ kind: 'implementation', status: 'done' }] }, live = { assignments: [{ kind: 'implementation', status: 'started' }] };
  const p = plan([w('W-1', { phase: 'implementation' }), w('W-2'), loose('W-3', worked),
    loose('W-9', { phase: 'implementation', ...live }), loose('W-4', { owner: null, deps: ['W-9'] }), loose('W-5', { owner: null, related: [{ to: 'W-9', kind: 'same-work' }] })]);
  for (const [id, why] of [['W-2', /pinned/], ['W-4', /W-9 shares/], ['W-5', /W-9 shares/]])
    assert.deepEqual([p[id].action, /busy with W-1/.test(p[id].reason), why.test(p[id].reason)], [null, true, true], `${id}: ${p[id].reason}`);
  assert.deepEqual([p['W-3'].action, p['W-3'].to], ['queue', S2], 'Alex 11-16: one queue; having worked on it once no longer binds it');
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
  assert.match(p['W-1'].reason, /factory developer/);
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
    loose('W-1', { owner: null, repo: 'teamwork-mini-mcp' }), loose('W-2', { owner: null, repo: 'app' }), loose('W-3', { owner: null }),
  ], hcfg).map(x => [x.id, x]));
  assert.equal(p['W-1'].to, H);
  assert.notEqual(p['W-2'].to, H);
  assert.notEqual(p['W-3'].to, H);
  const pinned = autoDispatchPlan([w('W-4', { owner: S1, repo: 'teamwork-mini-mcp' })], hcfg)[0];
  assert.deepEqual([pinned.action, /can't work in teamwork-mini-mcp/.test(pinned.reason)], [null, true], pinned.reason);
});

test('a host stream also takes records on the branches it names, so Mutation work runs on the host', () => {
  const H = 'sup: host';
  const hcfg = { ...cfg, mutationBranch: undefined, supervisors: { ...cfg.supervisors, [H]: { repos: { 'customer-configs': '~/Code/repos/customer-configs' }, branches: 'alex/(mutation-tester|test-quality/mutation-gaps)' } } };
  const p = Object.fromEntries(autoDispatchPlan([
    loose('W-1', { owner: null, repo: 'app', links: { branch: 'alex/test-quality/mutation-gaps-3' } }),
    loose('W-2', { owner: null, repo: 'customer-configs' }),
    loose('W-3', { owner: null, repo: 'app', links: { branch: 'alex/security/graphql-mutation-id-loads' } }),
  ], hcfg).map(x => [x.id, x]));
  assert.equal(p['W-1'].to, H);
  assert.match(p['W-2'].reason, /sup: host with W-1/, 'waits for the host, never an sbx stream');
  assert.notEqual(p['W-3'].to, H);
});

import { scoutPlan, sentryCited } from '../core/scout.mjs';
const SC = { maxProposals: 3, gapHours: 6, maxUntriaged: 5, projects: ['web', 'app-eu'] };
const scfg = { ...cfg, scout: SC };
const NOW = '2026-11-09T12:00:00.000Z';
const scout = (id, over = {}) => w(id, { kind: 'scout', phase: 'done', completion: { at: '2026-11-09T05:00:00.000Z' }, ...over });

test('an idle stream with nothing to dispatch gets a Sentry scout that skips issues the board already cites', () => {
  const works = [w('W-1', { phase: 'implementation' }), loose('W-2', { owner: null, phase: 'done', links: { sentry: 'https://acmeapp.sentry.io/issues/6012345678/' }, updates: [{ text: 'Seen as APP-EU-2K4 too' }] })];
  const p = scoutPlan(works, autoDispatchPlan(works, scfg), scfg, NOW);
  assert.equal(p.to, S2, 'the free stream, not the one building W-1');
  assert.deepEqual([p.create.kind, p.create.owner, p.create.phase, p.create.title], ['scout', S2, 'ready', 'Sentry scout 2026-11-09 12:00Z']);
  assert.match(p.create.objective, /6012345678, APP-EU-2K4/);
  assert.match(p.create.objective, /web, app-eu/);
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

test('a host stream never scouts: scout work is app', () => {
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
  assert.deepEqual(sentryCited([{ title: 'WEB-1A2 crash', objective: 'https://sentry.io/organizations/acmeapp/issues/42/ and WEB-IN things', links: {}, updates: [] }], SC.projects), ['42', 'WEB-1A2', 'WEB-IN'],
    'an all-letter word like WEB-IN is skipped too: a needless skip costs nothing, a missed id re-files a tracked error (W-348)');
  assert.deepEqual(sentryCited([{ title: 'x', objective: 'https://acme-org.sentry.io/issues/WEB-ETM and WEB-GVZ', links: {}, updates: [] }], SC.projects), ['WEB-ETM', 'WEB-GVZ'], 'W-323 and W-343 cite all-letter short ids (W-348)');
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
  const pc = { ...cfg, prApproval: { trusted: ['teamwork'], repos: [DEFAULT_REPO, 'customer-configs'] } };
  const at = (repo) => autoDispatchPlan([loose('W-1', { kind: 'build', source: { type: 'agent', by: 'local-head' }, repo })], pc)[0];
  assert.equal(at('teamwork-mini-mcp').action, 'queue');
  assert.match(at('customer-configs').reason, /Alex's go/);
  assert.match(at(undefined).reason, /Alex's go/, 'no repo means the default repo');
});

test('support work queues ahead of ordinary work; priority-1 work still cuts in first (Alex, 11-09)', () => {
  const order = autoDispatchPlan([loose('W-1'), loose('W-2', { support: true }), loose('W-3', { priority: 1 })], { ...cfg, supervisors: { [S1]: {} } }).filter(p => p.action).map(p => p.id);
  assert.deepEqual(order, ['W-3']);
  const two = autoDispatchPlan([loose('W-1'), loose('W-2', { support: true })], { ...cfg, supervisors: { [S1]: {} } }).filter(p => p.action).map(p => p.id);
  assert.deepEqual(two, ['W-2']);
});

test('queued support work takes a free stream before a parked job resumes there (Alex, 11-09, W-313)', () => {
  const parked = w('W-1', { phase: 'implementation', parked: [{ assignmentId: 'R1', waitingOn: 'TB-9', cleared: true }], assignments: [{ id: 'R1', kind: 'implementation', owner: S1, status: 'blocked', waitingOn: 'TB-9' }] });
  const p = plan([parked, w('W-2', { support: true })]);
  assert.equal(p['W-2'].action, 'queue');
  assert.equal(p['W-1'].action, null); assert.match(p['W-1'].reason, /busy with W-2/);
});

import { scoutBrief } from '../core/scout.mjs';
test("the scout reproduces on an origin/main worktree, never the clone's base checkout, which may sit on production (W-327)", () => {
  const b = scoutBrief({ projects: ['p'], maxProposals: 2 }, []);
  assert.match(b, /fresh worktree off origin\/main/);
  assert.match(b, /never the clone's base checkout/);
});

test('support work skips the new-PR go when dispatching (W-329)', () => {
  const run = support => autoDispatchPlan([w('W-1', { kind: 'build', source: { type: 'manual' }, support })], { ...cfg, prApproval: { trusted: ['teamwork'] } }, { terminals: [] })[0];
  assert.match(run(false).reason, /Alex's go/, 'unasked extra work waits');
  assert.ok(run(true).action, 'support work dispatches');
});

test("a record pinned to a host stream on someone's word is sent there even outside the host's repos; unpinned, a sandbox stream takes it (W-356: W-354 ACME)", () => {
  const H = 'sup: host', hcfg = { ...cfg, supervisors: { ...cfg.supervisors, [H]: { repos: { 'teamwork-mini-mcp': {} } } } };
  const rec = over => w('W-354', { owner: H, stream: H, support: true, kind: 'build', source: { type: 'teamwork' }, ...over });
  const run = over => autoDispatchPlan([rec(over)], hcfg, { terminals: [] })[0];
  assert.notEqual(run({}).to, H, 'owner alone does not bind: unpinned app work goes to a sandbox stream');
  assert.deepEqual([run({ streamPin: { by: "local-head, on Alex's word" } }).action, run({ streamPin: { by: 'x' } }).to], ['queue', H]);
});

test('an assignment recorded as queued, with no dispatch request, gets one when its stream is free (W-482: W-481 R1)', () => {
  const queued = w('W-481', { phase: 'queued', owner: S2, assignments: [{ id: 'R1', kind: 'implementation', status: 'queued', owner: S2 }] });
  assert.equal(plan([queued])['W-481']?.action, 'request', 'it does not wait on itself');
  const behind = plan([queued, w('W-376', { phase: 'implementation', owner: S2, assignments: [{ id: 'R1', kind: 'implementation', status: 'started' }] })]);
  assert.match(behind['W-481'].reason, /busy with W-376/, 'a busy stream still makes it wait its turn');
});

// W-505 (Alex 11-16: "1 queue balanced among streams"): 19:00Z, stream-1 ran W-235 with three fixes rounds waiting behind it
// while stream-2 sat free. A fixes or review request no worker has started joins one factory queue.
const fixesWaiting = (id, over = {}) => loose(id, { phase: 'fixes', stream: S1, owner: S1, head: 'h1', links: { pr: `https://github.com/acme-org/app/pull/${id.slice(2)}` },
  assignments: [{ id: 'R1', kind: 'implementation', status: 'done' }], requests: [{ id: 'R5', type: 'fixes', ack: null, head: 'h1', delivery: 'pending' }], ...over });

test('a fixes round waiting on a busy stream goes to the next free stream; the rest wait their turn in one queue (W-505)', () => {
  const running = loose('W-235', { phase: 'implementation', stream: S1, owner: S1, assignments: [{ id: 'R9', kind: 'implementation', status: 'started' }] });
  const p = plan([running, fixesWaiting('W-71'), fixesWaiting('W-76'), fixesWaiting('W-478')]);
  assert.deepEqual([p['W-71'].action, p['W-71'].to], ['route', S2], 'the built stream is busy, so the free one takes it');
  assert.equal(p['W-71'].request, 'W-71/R5');
  assert.equal(p['W-76'].action, null); assert.match(p['W-76'].reason, /every stream is busy/);
  assert.equal(p['W-478'].action, null);
});

test('a fixes round whose own stream is free stays there, and one Alex pinned waits for its stream (W-505)', () => {
  assert.deepEqual([plan([fixesWaiting('W-71')])['W-71'].action, plan([fixesWaiting('W-71')])['W-71'].to], ['deliver', S1]);
  const running = loose('W-235', { phase: 'implementation', stream: S1, owner: S1, assignments: [{ id: 'R9', kind: 'implementation', status: 'started' }] });
  const pinned = plan([running, fixesWaiting('W-71', { streamPin: { by: 'Alex' } })]);
  assert.equal(pinned['W-71'].action, null); assert.match(pinned['W-71'].reason, /busy with W-235.*pinned/);
});

test('a fixes round already told to its stream stays with it, so no supervisor holds a stale notice (W-505)', () => {
  const running = loose('W-235', { phase: 'implementation', stream: S1, owner: S1, assignments: [{ id: 'R9', kind: 'implementation', status: 'started' }] });
  const p = Object.fromEntries(autoDispatchPlan([running, fixesWaiting('W-71')], { ...cfg, toldRequests: new Set(['W-71/R5']) }).map(x => [x.id, x]));
  assert.notEqual(p['W-71']?.action, 'route');
});

test('a fixes round GitHub asked for reaches a stream while the record has open questions; new work still waits on them (W-544)', () => {
  const parkedOn = { assignments: [{ id: 'R1', kind: 'implementation', status: 'done' }, { id: 'R4', kind: 'fixes', status: 'blocked', waitingOn: 'TB-253' }], openQuestions: 2 };
  const p = plan([fixesWaiting('W-77', { ...parkedOn, requests: [{ id: 'R5', type: 'fixes', by: 'github', ack: null, head: 'h1', delivery: 'pending' }] })]);
  assert.deepEqual([p['W-77'].action, p['W-77'].request], ['deliver', 'W-77/R5']);
  assert.equal(plan([loose('W-1', { openQuestions: 1 })])['W-1'].action, null);
});

test("a project's task that isn't ready to start waits, naming what it needs (projects phase B)", () => {
  const p = plan([loose('W-1', { projectGate: { slug: '2026-10-position-end-date', ready: false, reasons: ['no test plan for task 102'] } }), loose('W-2', { projectGate: { slug: 'x', ready: true, reasons: [] } })]);
  assert.equal(p['W-1'].action, null); assert.match(p['W-1'].reason, /project 2026-10-position-end-date isn't ready for it: no test plan for task 102/);
  assert.equal(p['W-2'].action, 'queue');
});

test('a fixes round with a queued job nobody has started, and a request no stream was told of, is in the factory queue (W-533)', () => {
  const p = plan([fixesWaiting('W-76', { assignments: [{ id: 'R1', kind: 'implementation', status: 'done' }, { id: 'R12', kind: 'fixes', status: 'queued' }] })]);
  assert.deepEqual([p['W-76'].action, p['W-76'].request], ['deliver', 'W-76/R5']);
});

test('a dispatch its supervisor acked but has not started yet still holds the stream (W-554)', () => {
  const acked = loose('W-341', { phase: 'queued', owner: S2, stream: S2, requests: [{ id: 'R1', type: 'dispatch', ack: { outcome: 'received', by: S2 } }] });
  const p = plan([acked, loose('W-553', { owner: null }), loose('W-1', { owner: S1, stream: S1, phase: 'implementation' })]);
  assert.equal(p['W-553'].action, null, 'every stream is taken');
  assert.match(p['W-553'].reason, /W-341/);
});

// W-556 (Alex 11-18): the internal review is the pre-ready gate, and Claude reviews it whichever agent built the PR.
test('a review round goes to a Claude stream even when a Codex stream built the record, is pinned or is free (W-556)', () => {
  const codex = { ...cfg, supervisors: { [S1]: cfg.supervisors[S1], [S2]: { ...cfg.supervisors[S2], agent: 'codex' } } };
  const reviewWaiting = (id, over = {}) => fixesWaiting(id, { phase: 'review', stream: S2, owner: S2, requests: [{ id: 'R6', type: 'review', ack: null, head: 'h1', delivery: 'pending' }], ...over });
  const p = id => Object.fromEntries(autoDispatchPlan(id, codex).map(x => [x.id, x]));
  assert.deepEqual([p([reviewWaiting('W-71')])['W-71'].action, p([reviewWaiting('W-71')])['W-71'].to], ['route', S1], 'built on Codex, reviewed on Claude');
  assert.equal(p([reviewWaiting('W-72', { streamPin: { by: 'Alex' } })])['W-72'].to, S1, 'a pin to a Codex stream does not hold a review there');
  const running = loose('W-235', { phase: 'implementation', stream: S1, owner: S1, assignments: [{ id: 'R9', kind: 'implementation', status: 'started' }] });
  const busy = p([running, reviewWaiting('W-73')])['W-73'];
  assert.equal(busy.action, null, 'the only Claude stream is busy: it waits, never falls back to Codex');
  assert.match(busy.reason, /Claude/);
  const fixes = p([running, fixesWaiting('W-74', { stream: S2, owner: S2 })])['W-74'];
  assert.equal(fixes.to, S2, 'a fixes round still goes to a Codex stream');
});

// W-557 (Alex 11-18): a job goes to the agent that fits it; after a wait any free stream takes it, so nothing starves.
test('a job prefers the agent that fits its type, and takes any free stream once it has waited long enough (W-557)', () => {
  const S3 = 'sup: stream-3';
  const mixed = { ...cfg, supervisors: { [S1]: cfg.supervisors[S1], [S2]: { ...cfg.supervisors[S2], agent: 'codex' }, [S3]: {} }, agentFallbackMs: 20 * 60000 };
  const at = (works, now = '2026-11-18T19:00:00.000Z') => Object.fromEntries(autoDispatchPlan(works, { ...mixed, now }).map(x => [x.id, x]));
  const req = at => [{ id: 'R5', type: 'fixes', ack: null, head: 'h1', delivery: 'pending', at }];
  // A fixes round with a Codex stream free goes there, though a Claude stream is free too.
  assert.equal(at([fixesWaiting('W-71', { stream: null, owner: null, requests: req('2026-11-18T18:59:00.000Z') })])['W-71'].to, S2);
  // A planning job goes to Claude even when Codex is the least loaded.
  assert.notEqual(at([loose('W-512', { owner: null, repo: 'project-planning', createdAt: '2026-11-18T18:59:00.000Z' })])['W-512'].to, S2);
  // Codex busy: a fresh fixes round waits for it, an old one takes the free Claude stream.
  const codexBusy = loose('W-9', { phase: 'implementation', stream: S2, owner: S2, assignments: [{ id: 'R1', kind: 'implementation', status: 'started' }] });
  const fresh = at([codexBusy, fixesWaiting('W-72', { stream: null, owner: null, requests: req('2026-11-18T18:55:00.000Z') })])['W-72'];
  assert.equal(fresh.action, null); assert.match(fresh.reason, /Codex stream.*20 min/);
  assert.ok([S1, S3].includes(at([codexBusy, fixesWaiting('W-73', { stream: null, owner: null, requests: req('2026-11-18T18:30:00.000Z') })])['W-73'].to), 'waited 30 min: any free stream');
  // A model on the record wins: it needs Claude, whatever the job.
  assert.notEqual(at([fixesWaiting('W-74', { stream: null, owner: null, model: 'opus', requests: req('2026-11-18T18:59:00.000Z') })])['W-74'].to, S2);
  // A Sentry fix the scout proposed prefers Codex; a plain new build has no preference.
  const scout = loose('W-60', { kind: 'scout', phase: 'done', owner: null });
  assert.equal(at([scout, loose('W-61', { owner: null, proposedFrom: 'W-60', createdAt: '2026-11-18T18:59:00.000Z' })])['W-61'].to, S2);
});

test("a GitHub fixes round reaches its stream while the record is parked on a question too; other waits still hold it (W-566)", () => {
  const gh = (id, waitingOn, by = 'github') => fixesWaiting(id, { waitingOn, requests: [{ id: 'R5', type: 'fixes', by, ack: null, head: 'h1', delivery: 'pending' }] });
  assert.equal(plan([gh('W-77', { who: 'TB-256', what: 'product call' })])['W-77'].action, 'deliver');
  assert.equal(plan([gh('W-78', { who: 'TB-256', what: 'product call' }, 'sup: s1')])['W-78'].action, null, 'a round nobody outside asked for still waits');
  assert.equal(plan([gh('W-79', { who: 'Casey', what: 'QA sign-off' })])['W-79'].action, null, 'a hold on a person still holds');
});

test('a scout proposal the factory lead already triaged into intake no longer pauses the scout (W-577)', () => {
  const none = works => scoutPlan(works, autoDispatchPlan(works, scfg), scfg, NOW).to;
  const triaged = n => Array.from({ length: n }, (_, i) => loose(`W-${i + 2}`, { owner: null, phase: 'intake', proposedFrom: 'W-1', triage: { bucket: 'intake', by: 'factory lead', note: 'not reproduced' } }));
  assert.equal(none([scout('W-1'), ...triaged(6)]), S1, 'six triaged into intake: the scout runs');
  const untouched = loose('W-9', { owner: null, phase: 'proposed', proposedFrom: 'W-1' });
  assert.equal(none([scout('W-1'), ...triaged(4), untouched]), S1, 'one untriaged is under the limit');
});

// W-582: a round a supervisor queued for its own worker, with no worker live on the record, while that stream runs another
// record's job: after the fallback wait it's offered to a free stream that can take it (reviews to Claude only, W-556).
test("a supervisor's own queued round waiting behind another job on its stream is offered to a free stream after a while (W-582)", () => {
  const S3 = 'sup: stream-3';
  const mixed = { ...cfg, supervisors: { [S1]: { worker: 'sbx: s1' }, [S2]: { worker: 'sbx: s2', agent: 'codex' }, [S3]: { worker: 'sbx: s3' } }, agentFallbackMs: 20 * 60000 };
  const at = (works, now) => Object.fromEntries(autoDispatchPlan(works, { ...mixed, now }).map(x => [x.id, x]));
  const other = loose('W-77', { phase: 'fixes', stream: S2, owner: S2, assignments: [{ id: 'R24', kind: 'fixes', status: 'started', owner: 'sbx: s2' }] });
  const mine = (over = {}) => loose('W-494', { phase: 'implementation', stream: S2, owner: S2, assignments: [
    { id: 'R1', kind: 'implementation', status: 'blocked', owner: 'sbx: s2', waitingOn: 'R2 verification' },
    { id: 'R2', kind: 'review', status: 'queued', owner: 'sbx: s2', version: 1, at: '2026-11-19T18:36:00.000Z', evidence: 'brief ~/plans/x.md' }], ...over });
  const p = at([other, mine()], '2026-11-19T21:00:00.000Z')['W-494'];
  assert.deepEqual([p.action, p.from, p.assignmentId, p.version], ['offer', S2, 'R2', 1]);
  assert.notEqual(p.to, S2);
  assert.match(p.reason, /busy with W-77/);
  assert.equal(at([other, mine()], '2026-11-19T18:40:00.000Z')['W-494']?.action ?? null, null, 'not before the fallback wait');
  assert.equal(at([mine()], '2026-11-19T21:00:00.000Z')['W-494']?.action ?? null, null, 'its own stream is free: it stays');
  assert.equal(at([other, mine({ streamPin: { by: 'Alex' } })], '2026-11-19T21:00:00.000Z')['W-494']?.action ?? null, null, 'a stream Alex pinned keeps it');
});

// W-591: W-583's review (#8968 against production) waited an hour while priority-1 work took stream-1 first.
test('a production hotfix and its rounds go first in the queue, ahead of priority-1 work (W-591)', () => {
  const one = { ...cfg, supervisors: { [S1]: {} } };
  const first = works => autoDispatchPlan(works, one).filter(p => p.action).map(p => p.id);
  assert.deepEqual(first([loose('W-588', { priority: 1 }), loose('W-590', { links: { branch: 'hotfix/hide-login' } })]), ['W-590'], 'a new hotfix, before its PR exists: its branch says so');
  const review = fixesWaiting('W-583', { phase: 'review', stream: S1, owner: S1, hotfix: true, requests: [{ id: 'R2', type: 'review', ack: null, head: 'h1', delivery: 'pending' }] });
  assert.deepEqual(first([loose('W-588', { priority: 1 }), review]), ['W-583'], "a hotfix's review round");
  const running = loose('W-1', { phase: 'implementation', stream: S1, owner: S1, assignments: [{ id: 'R9', kind: 'implementation', status: 'started' }] });
  const waits = autoDispatchPlan([running, loose('W-590', { hotfix: true })], one).find(p => p.id === 'W-590');
  assert.equal(waits.action, null, 'it never interrupts running work');
  assert.match(waits.reason, /with W-1/);
});
