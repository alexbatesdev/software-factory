import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatsOf, planFactory, planStop, slotFor, planSeatRestarts } from '../fleet/factory.mjs';

const config = {
  routing: { supervisors: { 'sup: s1': { workspace: 'Stream 1', worker: 'sbx: s1' } } },
  factory: { seats: [
    { label: 'board', kind: 'shell', workspace: 'Terminals', tab: 'Triage board', run: './start.sh', expect: 'server.mjs' },
    { label: 'local-head', kind: 'claude', role: 'local-head', workspace: 'Main', tab: 'Local head', stays: true },
    { label: 'unblocker', kind: 'codex', resume: 'abc', workspace: 'Main', tab: 'Agent Unblocker', stays: true },
    { label: 'router', kind: 'claude', role: 'questions-router', workspace: 'Main', tab: 'Assistants', enabled: false },
  ] },
};
const pane = (label, workspace, tab, argv, extra = {}) => ({ pane: `p-${label}`, label, workspace, tab, argv, ...extra });
const actionsOf = plan => Object.fromEntries(plan.map(s => [s.seat.label, s.action]));

test('streams come from the routing config: a supervisor seat and its sbx worker seat in the stream workspace', () => {
  const seats = seatsOf(config);
  assert.deepEqual(seats.filter(s => s.workspace === 'Stream 1').map(s => [s.label, s.kind, s.tab, s.role]),
    [['sup: s1', 'claude', 'Orchestrator', 'stream-supervisor'], ['sbx: s1', 'sbx', 'Worker', undefined]]);
  assert.ok(!seats.some(s => s.label === 'router'), 'a disabled seat is left out');
});

test('each seat gets the smallest action that brings it up, and nothing that is already running is touched', () => {
  const plan = planFactory(seatsOf(config), [
    pane('board', 'Terminals', 'Triage board', 'zsh'),
    pane('', 'Main', 'Local head', 'claude --resume x', { agentName: 'local-head' }),
    pane('unblocker', 'Main', 'Agent Unblocker', 'codex resume abc'),
    pane('sup: s1', 'Stream 1', 'Orchestrator', 'claude --agent stream-supervisor'),
    pane('sbx: s1', 'Stream 1', 'Worker', 'zsh'),
  ]);
  assert.deepEqual(actionsOf(plan), { board: 'report-stopped', 'local-head': 'report-role', unblocker: 'none', 'sup: s1': 'none', 'sbx: s1': 'reconnect' });
  assert.equal(plan.find(s => s.seat.label === 'local-head').rename, true, 'found by agent name, so its pane gets the label');
});

test('a missing seat is created where the manifest puts it; in Terminals, which is Alex\'s, a seat is only ever reported', () => {
  const plan = planFactory(seatsOf(config), []);
  assert.deepEqual(actionsOf(plan), { board: 'report-missing', 'local-head': 'create', unblocker: 'create', 'sup: s1': 'create', 'sbx: s1': 'report-missing' });
});

test('a seat found outside its workspace is reported, not moved or restarted', () => {
  const plan = planFactory(seatsOf(config), [pane('local-head', 'Terminals', 'x', 'zsh')]);
  assert.equal(actionsOf(plan)['local-head'], 'report-misplaced');
});

test('tear-down stops workers first and the board server last, skips what is stopped, and keeps the seats marked stays unless asked for all', () => {
  const seats = [{ label: 'server', kind: 'shell', expect: 'live.mjs' }, ...seatsOf(config)];
  const panes = [
    pane('server', 'Services', 'Board', 'node bin/live.mjs'),
    pane('local-head', 'Main', 'Local head', 'claude --agent local-head'),
    pane('unblocker', 'Main', 'Agent Unblocker', 'codex resume abc'),
    pane('sup: s1', 'Stream 1', 'Orchestrator', 'claude --agent stream-supervisor'),
    pane('sbx: s1', 'Stream 1', 'Worker', 'sbx exec -it s1 claude'),
  ];
  const order = s => s.map(x => [x.seat.label, x.action]);
  assert.deepEqual(order(planStop(seats, panes, { serverLabel: 'server' })),
    [['sbx: s1', 'stop'], ['sup: s1', 'stop'], ['board', 'skip-missing'], ['server', 'stop']]);
  const all = order(planStop(seats, panes, { serverLabel: 'server', all: true }));
  assert.deepEqual([all.find(([l]) => l === 'unblocker'), all.at(-1)], [['unblocker', 'stop'], ['local-head', 'stop']]);
});

test('a seat still under its old label is found, stopped and relabelled, never doubled', () => {
  const cfg = { routing: { supervisors: { 'sup: s2': { workspace: 'Stream 2', worker: 'sbx: s2' } }, renamed: { _doc: 'x', 'sup: old': 'sup: s2' } } };
  const seats = seatsOf(cfg);
  const panes = [pane('sup: old', 'Stream 2', 'Orchestrator', 'claude --agent stream-supervisor')];
  const up = planFactory(seats, panes).find(s => s.seat.label === 'sup: s2');
  assert.deepEqual([up.action, up.pane, up.rename], ['none', 'p-sup: old', true]);
  assert.deepEqual(planStop(seats, panes).map(s => [s.seat.label, s.action]), [['sbx: s2', 'skip-missing'], ['sup: s2', 'stop']]);
});

// A fake herdr: a created workspace comes with one tab labelled "1" holding one pane, as real herdr does.
function fakeHerdr() {
  const st = { workspaces: [], tabs: [], panes: [] }, calls = [];
  let n = 0;
  const run = async (...a) => {
    calls.push(a.join(' '));
    const [k, op] = a;
    if (op === 'list') return { [`${k}s`]: structuredClone(st[`${k}s`]) };
    const tab = ws => { const t = { tab_id: `t${++n}`, workspace_id: ws, label: '1', pane_count: 1 }; st.tabs.push(t); st.panes.push({ pane_id: `p${++n}`, tab_id: t.tab_id }); return t; };
    if (k === 'workspace' && op === 'create') { const w = { workspace_id: `w${++n}`, label: a[a.indexOf('--label') + 1] }; st.workspaces.push(w); tab(w.workspace_id); return { workspace: w }; }
    if (k === 'tab' && op === 'create') { const t = tab(a[a.indexOf('--workspace') + 1]); t.label = a[a.indexOf('--label') + 1]; return { tab: t }; }
    if (k === 'tab' && op === 'rename') { st.tabs.find(t => t.tab_id === a[2]).label = a[3]; return {}; }
    if (k === 'pane' && op === 'split') { const t = st.panes.find(p => p.pane_id === a[2]).tab_id; const p = { pane_id: `p${++n}`, tab_id: t }; st.panes.push(p); st.tabs.find(x => x.tab_id === t).pane_count++; return { pane: p }; }
    throw new Error(`fake herdr: ${a.join(' ')}`);
  };
  return { run, st, calls };
}

test('seats created into a missing workspace share one workspace and use its first tab instead of leaving a stray "1"', async () => {
  const h = fakeHerdr();
  const a = await slotFor({ workspace: 'Services', tab: 'Board' }, h.run);
  const b = await slotFor({ workspace: 'Services', tab: 'Factory' }, h.run);
  const c = await slotFor({ workspace: 'Services', tab: 'Factory' }, h.run);
  assert.equal(h.st.workspaces.length, 1);
  assert.deepEqual(h.st.tabs.map(t => [t.label, t.pane_count]), [['Board', 1], ['Factory', 2]]);
  assert.equal(new Set([a, b, c]).size, 3);
});

test('a worker whose pane is gone but whose sandbox is known is adopted into a new Worker pane; unknown stays Alex\'s call', () => {
  const seats = seatsOf(config).map(s => s.label === 'sbx: s1' ? { ...s, sandbox: 'box-1' } : s);
  assert.equal(planFactory(seats, []).find(s => s.seat.label === 'sbx: s1').action, 'adopt');
  assert.equal(planFactory(seatsOf(config), []).find(s => s.seat.label === 'sbx: s1').action, 'report-missing');
});

test('once a day at the quiet hour, idle Claude seats with nothing waiting restart fresh; busy, stays, codex and sbx seats never', () => {
  const cfg = { ...config, factory: { seats: [...config.factory.seats, { label: 'lead', kind: 'claude', role: 'factory-lead', workspace: 'Services', tab: 'Factory' }, { label: 'router2', kind: 'claude', role: 'questions-router', workspace: 'Services', tab: 'Factory' }] } };
  const seats = seatsOf(cfg);
  const agents = [['local-head', 'idle'], ['unblocker', 'idle'], ['lead', 'done'], ['router2', 'idle'], ['sup: s1', 'idle'], ['sbx: s1', 'idle']].map(([label, status]) => ({ label, status, ref: `p-${label}` }));
  const state = { messages: {}, work: {} };
  const at = (now, extra = {}) => planSeatRestarts(seats, agents, extra.state || state, { now, hourUtc: 10, enabled: true, ...extra }).map(r => [r.seat.label, r.pane]);
  assert.deepEqual(at('2026-11-10T10:05:00.000Z'), [['lead', 'p-lead'], ['router2', 'p-router2'], ['sup: s1', 'p-sup: s1']]);
  assert.deepEqual(at('2026-11-10T11:05:00.000Z'), [], 'only in the quiet hour');
  assert.deepEqual(at('2026-11-10T10:05:00.000Z', { enabled: false }), []);
  assert.deepEqual(at('2026-11-10T10:30:00.000Z', { done: { lead: '2026-11-10', router2: '2026-11-09' } }).map(([l]) => l), ['router2', 'sup: s1'], 'once per seat per day');
  const busy = { messages: { 'M-1': { to: 'router2', ackedAt: null }, 'M-2': { to: 'lead', ackedAt: 'x' } },
    work: { 'W-1': { stream: 'sup: s1', assignments: [{ id: 'R1', status: 'started' }] }, 'W-2': { stream: 'lead', assignments: [{ status: 'started' }] } } };
  assert.deepEqual(at('2026-11-10T10:05:00.000Z', { state: busy }).map(([l]) => l), ['lead'], 'an unacked message or a started job on its stream keeps a seat');
  agents.find(a => a.label === 'lead').status = 'working';
  assert.deepEqual(at('2026-11-10T10:05:00.000Z').map(([l]) => l), ['router2', 'sup: s1'], 'a working seat is left alone');
});

test("a stream set to codex runs a Codex worker; every other seat, and its own supervisor, stays Claude", async () => {
  const { agentOf, QUIT } = await import('../fleet/factory.mjs');
  const cfg = { routing: { supervisors: { ...config.routing.supervisors, 'sup: s2': { workspace: 'Stream 2', worker: 'sbx: s2', agent: 'codex' } } } };
  assert.deepEqual(seatsOf(cfg).filter(s => s.kind === 'sbx').map(s => [s.label, s.agent]), [['sbx: s1', 'claude'], ['sbx: s2', 'codex']]);
  assert.deepEqual(['sbx: s2', 'sup: s2', 'sbx: s1', 'local-head'].map(l => agentOf(cfg, l)), ['codex', 'claude', 'claude', 'claude']);
  assert.deepEqual([QUIT.claude, QUIT.codex], ['/exit', '/quit']);
});

test("a fixed seat that runs Codex is woken as Codex (W-413: the agent unblocker's board messages never arrived)", async () => {
  const { agentOf } = await import('../fleet/factory.mjs');
  const cfg = { routing: { supervisors: {} }, factory: { seats: [{ label: 'agent-unblocker', kind: 'codex' }, { label: 'board lead', kind: 'claude' }, { label: 'script', kind: 'shell' }] } };
  assert.deepEqual(['agent-unblocker', 'board lead', 'local-head'].map(l => agentOf(cfg, l)), ['codex', 'claude', 'claude']);
});

test("a seat whose role's board tools changed restarts at its next idle gap, outside the daily hour, once (W-431: request_aws never reached the supervisors)", () => {
  const seats = [{ label: 'board lead', kind: 'claude', role: 'factory-lead' }, { label: 'sup: s1', kind: 'claude', role: 'stream-supervisor' }, { label: 'local-head', kind: 'claude', stays: true }];
  const agents = [{ label: 'board lead', ref: 'p1', status: 'idle' }, { label: 'sup: s1', ref: 'p2', status: 'idle' }, { label: 'local-head', ref: 'p3', status: 'idle' }];
  const state = { messages: {}, work: { 'W-1': { id: 'W-1', stream: 'sup: s1', assignments: [{ id: 'R1', status: 'started' }] } } };
  const toolsOf = s => ({ 'factory-lead': 'a', 'stream-supervisor': 'b2' })[s.role] || 'x';
  const plan = (st, toolsDone) => planSeatRestarts(seats, agents, st, { now: '2026-11-11T23:00:00.000Z', hourUtc: 10, enabled: true, toolsOf, toolsDone }).map(r => r.seat.label);
  assert.deepEqual(plan(state, { 'board lead': 'a', 'sup: s1': 'b1' }), [], 'the supervisor is mid-job, so it waits');
  assert.deepEqual(plan({ ...state, work: {} }, { 'board lead': 'a', 'sup: s1': 'b1' }), ['sup: s1'], 'free: restarts for its new tools');
  assert.deepEqual(plan({ ...state, work: {} }, { 'board lead': 'a', 'sup: s1': 'b2' }), [], 'once');
  assert.deepEqual(plan({ ...state, work: {} }, {}), ['board lead', 'sup: s1'], 'never recorded: restart once to be sure; a stays seat never');
});

test("a running agent seat with no herdr agent name gets its name, so `herdr agent prompt <seat>` reaches it (W-495: local-head started by hand)", () => {
  const plan = planFactory(seatsOf(config), [
    pane('local-head', 'Main', 'Local head', 'claude --agent local-head'),
    pane('unblocker', 'Main', 'Agent Unblocker', 'codex resume abc', { agentName: 'unblocker' }),
    pane('board', 'Terminals', 'Triage board', 'node server.mjs'),
  ]);
  const of = l => plan.find(s => s.seat.label === l);
  assert.equal(of('local-head').action, 'none');
  assert.equal(of('local-head').name, 'local-head');
  assert.equal(of('unblocker').name, undefined, 'already named');
  assert.equal(of('board').name, undefined, 'a shell seat has no agent');
});

test('the server names any running seat agent that lost its herdr name, so `herdr agent prompt <seat>` keeps working (W-495 follow-up)', async () => {
  const { seatRenames } = await import('../fleet/factory.mjs');
  const agents = [{ ref: 'p1', label: 'local-head', agent: 'claude', name: null }, { ref: 'p2', label: 'unblocker', agent: 'codex', name: 'unblocker' },
    { ref: 'p3', label: 'sup: s1', agent: 'claude', name: 'sup-s1' }, { ref: 'p4', label: 'sbx: s1', agent: 'claude', name: null }, { ref: 'p5', label: 'board', agent: null, name: null }];
  assert.deepEqual(seatRenames(seatsOf(config), agents), [{ ref: 'p1', label: 'local-head', name: 'local-head' }]);
});

test("a seat whose herdr name is held by another pane is reported with who holds it and what to do, not started into an error (W-525)", () => {
  const plan = planFactory(seatsOf(config), [
    pane('unblocker', 'Main', 'Agent Unblocker', 'zsh'),
    pane('utility', 'Main', 'Assistants', 'codex resume abc', { agentName: 'unblocker', ref: 'p-util' }),
  ]);
  const s = plan.find(x => x.seat.label === 'unblocker');
  assert.equal(s.action, 'report-name-taken');
  assert.match(s.why, /herdr name "unblocker" is held by the pane labelled "utility" .*rename that agent .*or relabel the panes/);
});

// W-557 trial (Alex 11-18): a seat can switch between Claude and Codex in its own pane.
test('a seat switched to Codex while Claude still runs in its pane is reported, never started over it (W-557)', () => {
  const cfg = { routing: { supervisors: { 'sup: s1': { workspace: 'Stream 1', supervisorKind: 'codex' } } }, factory: { seats: [{ label: 'router', kind: 'codex', role: 'questions-router', workspace: 'Main', tab: 'A' }] } };
  const seats = seatsOf(cfg);
  assert.equal(seats.find(s => s.label === 'sup: s1').kind, 'codex', 'a supervisor seat takes its stream\'s supervisorKind');
  const plan = planFactory(seats, [pane('router', 'Main', 'A', 'claude --agent questions-router'), pane('sup: s1', 'Stream 1', 'Orchestrator', 'codex')]);
  assert.deepEqual(actionsOf(plan), { router: 'report-kind', 'sup: s1': 'none' }, 'a running Codex seat has no --agent to check');
  assert.match(plan[0].why, /claude.*codex/i);
  assert.equal(actionsOf(planStop(seats, [pane('router', 'Main', 'A', 'claude --agent questions-router')])).router, 'stop', 'down stops whichever agent runs there');
});

test('the seat restart switches a seat to its configured agent at its next gap (W-557)', () => {
  const seats = [{ label: 'router', kind: 'codex', role: 'questions-router' }];
  const agents = [{ label: 'router', status: 'idle', ref: 'p1', agent: 'claude' }];
  const at = agentsNow => planSeatRestarts(seats, agentsNow, { messages: {}, work: {} }, { now: '2026-11-18T19:00:00.000Z', hourUtc: 10, enabled: true, done: {} }).map(r => r.seat.label);
  assert.deepEqual(at(agents), ['router']);
  assert.deepEqual(at([{ ...agents[0], agent: 'codex' }]), [], 'already on Codex: nothing to do outside the daily hour');
});

test('a fresh Codex seat starts with its role, and a stop quits the agent actually running (W-557)', async () => {
  const { startSeat, stopSeat } = await import('../fleet/factory.mjs');
  const calls = [], herdr = async (...a) => { calls.push(a); return a[0] === 'pane' && a[1] === 'process-info' ? { process_info: { foreground_processes: [] } } : {}; };
  await startSeat({ label: 'router', kind: 'codex', role: 'questions-router' }, 'p1', herdr);
  const start = calls.find(c => c[0] === 'agent' && c[1] === 'start');
  assert.deepEqual(start.slice(0, 6), ['agent', 'start', 'router', '--kind', 'codex', '--pane']);
  assert.match(start.at(-1), /\.claude\/agents\/questions-router\.md/);
  calls.length = 0;
  await stopSeat({ label: 'router', kind: 'codex', role: 'questions-router' }, 'p1', herdr, 'claude --agent questions-router');
  assert.ok(calls.some(c => c[1] === 'send-text' && c[3] === '/exit'), 'Claude is running: /exit, not Codex\'s /quit');
});

test("a Codex seat is told its own pane: the shared Codex daemon's environment names whichever pane started it (W-560, W-557)", async () => {
  const { startSeat } = await import('../fleet/factory.mjs');
  const calls = [], herdr = async (...a) => { calls.push(a); return {}; };
  for (const seat of [{ label: 'router', kind: 'codex', role: 'questions-router' }, { label: 'unblocker', kind: 'codex', resume: 'abc' }]) {
    calls.length = 0;
    await startSeat(seat, 'w9:p7', herdr);
    const args = calls.find(c => c[1] === 'start').slice(calls.find(c => c[1] === 'start').indexOf('--') + 1);
    assert.ok(args.includes('shell_environment_policy.set.HERDR_PANE_ID="w9:p7"'), `${seat.label}: its commands see its pane`);
    assert.ok(args.includes('mcp_servers.software-factory.env.HERDR_PANE_ID="w9:p7"'), `${seat.label}: the factory server sees its pane`);
  }
  assert.equal(calls.find(c => c[1] === 'start').at(-1), 'abc', 'resume keeps its session id last');
});

test('a seat start herdr reports failed counts as started when the agent is running in the pane (W-557)', async () => {
  const { startSeat } = await import('../fleet/factory.mjs');
  const herdr = async (...a) => {
    if (a[1] === 'start') throw new Error('Command failed: herdr agent start');
    if (a[1] === 'process-info') return { process_info: { foreground_processes: [{ argv: ['codex', '-c', 'x'] }] } };
    return {};
  };
  await startSeat({ label: 'router', kind: 'codex', role: 'questions-router' }, 'p1', herdr);
  const none = async (...a) => { if (a[1] === 'start') throw new Error('Command failed'); return { process_info: { foreground_processes: [{ argv: ['zsh'] }] } }; };
  await assert.rejects(startSeat({ label: 'router', kind: 'codex', role: 'questions-router' }, 'p1', none), /Command failed/);
});

test("a seat's agent comes from its seat: a Codex supervisor or router is woken as Codex, a worker as its sandbox's agent (W-565)", async () => {
  const { seatAgent } = await import('../fleet/factory.mjs');
  const cfg = { routing: { supervisors: { 'sup: s1': { workspace: 'S1', worker: 'sbx: s1' }, 'sup: s2': { workspace: 'S2', worker: 'sbx: s2', agent: 'codex', supervisorKind: 'codex' } } },
    factory: { seats: [{ label: 'router', kind: 'codex', role: 'questions-router', workspace: 'M', tab: 'A' }, { label: 'lead', kind: 'claude', role: 'factory-lead', workspace: 'M', tab: 'A' }] } };
  assert.deepEqual(['sup: s1', 'sup: s2', 'sbx: s1', 'sbx: s2', 'router', 'lead', 'nobody'].map(l => seatAgent(cfg, l)), ['claude', 'codex', 'claude', 'codex', 'codex', 'claude', 'claude']);
});
