import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatsOf, planFactory, planStop } from '../fleet/factory.mjs';

const config = {
  routing: { supervisors: { 'sup: s1': { workspace: 'Stream 1', worker: 'sbx: s1' } } },
  factory: { seats: [
    { label: 'board', kind: 'shell', workspace: 'Terminals', tab: 'Triage board', run: './start.sh', expect: 'server.mjs' },
    { label: 'local-head', kind: 'claude', role: 'local-head', workspace: 'Main', tab: 'Local head' },
    { label: 'unblocker', kind: 'codex', resume: 'abc', workspace: 'Main', tab: 'Agent Unblocker' },
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

test('tear-down stops workers first and the board server last, skips what is stopped, and keeps local-head unless asked', () => {
  const seats = [{ label: 'server', kind: 'shell', expect: 'live.mjs' }, ...seatsOf(config)];
  const panes = [
    pane('server', 'Services', 'Board', 'node bin/live.mjs'),
    pane('local-head', 'Main', 'Local head', 'claude --agent local-head'),
    pane('unblocker', 'Main', 'Agent Unblocker', 'zsh'),
    pane('sup: s1', 'Stream 1', 'Orchestrator', 'claude --agent stream-supervisor'),
    pane('sbx: s1', 'Stream 1', 'Worker', 'sbx exec -it s1 claude'),
  ];
  const order = s => s.map(x => [x.seat.label, x.action]);
  assert.deepEqual(order(planStop(seats, panes, { serverLabel: 'server' })),
    [['sbx: s1', 'stop'], ['sup: s1', 'stop'], ['board', 'skip-missing'], ['unblocker', 'skip-stopped'], ['server', 'stop']]);
  assert.equal(planStop(seats, panes, { serverLabel: 'server', withLocalHead: true }).at(-1).seat.label, 'local-head');
});
