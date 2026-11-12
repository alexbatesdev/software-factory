import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFooter, agentState, layoutIssues } from '../fleet/status.mjs';

test('the Claude Code footer reports background shells', () => {
  assert.equal(parseFooter('  ⏵⏵ auto mode on · 1 shell').jobs, 1);
  assert.equal(parseFooter('  ⏵⏵ auto mode on · 3 shells').jobs, 3);
  assert.equal(parseFooter('  ⏵⏵ auto mode on').jobs, 0);
  assert.equal(parseFooter('').jobs, null, 'no footer means unknown, not zero');
});

test('a done turn with a running shell is waiting, not done', () => {
  const s = agentState({ status: 'done', jobs: 1 }, { activeWork: 1 });
  assert.equal(s.key, 'waiting');
  assert.match(s.text, /1 background shell/);
});

test('a done turn on a unit with active work is "turn ended", never task completion', () => {
  const s = agentState({ status: 'done', jobs: null }, { activeWork: 1 });
  assert.equal(s.key, 'turn-ended');
  assert.match(s.text, /work still active/);
  assert.doesNotMatch(s.text, /^done$/);
});

test('working and blocked pass through; done with nothing active is plain idle', () => {
  assert.equal(agentState({ status: 'working', jobs: 0 }, { activeWork: 1 }).key, 'working');
  assert.equal(agentState({ status: 'blocked', jobs: 0 }, { activeWork: 0 }).key, 'blocked');
  assert.equal(agentState({ status: 'done', jobs: 0 }, { activeWork: 0 }).key, 'idle');
});

test('layout: 3 panes per tab everywhere, board spawns in Board Actions, no Assistants workspace', () => {
  const workspaces = [{ workspace_id: 'w1', label: 'Main' }, { workspace_id: 'w2', label: 'Assistants' }, { workspace_id: 'w3', label: 'Board Actions' }, { workspace_id: 'w4', label: 'Terminals' }];
  const tabs = [{ workspace_id: 'w1', label: 'Head', pane_count: 4 }, { workspace_id: 'w3', label: 'runs', pane_count: 3 }];
  const agents = [{ label: 'triage-run TR-9', workspace: 'Main' }, { label: 'triage-run TR-8', workspace: 'Board Actions' }, { label: 'x', workspace: 'Terminals' }];
  const issues = layoutIssues({ workspaces, tabs, agents, units: [] });
  assert.equal(issues.length, 4, issues.join('\n'));
  assert.match(issues.join('\n'), /Main tab "Head" has 4 panes/);
  assert.match(issues.join('\n'), /Assistants/);
  assert.match(issues.join('\n'), /"triage-run TR-9" .*Board Actions/);
  assert.match(issues.join('\n'), /Terminals/);
});

test("layout: Terminals is Alex's, so its tabs have no pane limit", () => {
  const workspaces = [{ workspace_id: 'w4', label: 'Terminals' }];
  const tabs = [{ workspace_id: 'w4', label: 'A', pane_count: 6 }];
  assert.deepEqual(layoutIssues({ workspaces, tabs, agents: [], units: [] }), []);
});

test('layout: a host stream supervisor needs no sbx worker beside it (TB-159)', () => {
  const units = [{ name: 'Host', paired: null, supervisor: { label: 'sup: host', workspace: 'Host' }, worker: null }];
  assert.deepEqual(layoutIssues({ workspaces: [], tabs: [], agents: [], units }), []);
});

test("a stream worker's pane with no agent running still counts as the worker, so the factory can restart it (11-11: stream-2's Codex died at bootstrap and vanished)", async () => {
  const { seatPanes } = await import('../fleet/herdr.mjs');
  const panes = [{ pane_id: 'p1', label: 'sup: stream-2' }, { pane_id: 'p2', label: 'sbx: stream-2' }, { pane_id: 'p3', label: 'zsh' }];
  assert.deepEqual(seatPanes(panes, [{ pane_id: 'p1' }]).map(p => p.pane_id), ['p1', 'p2'], 'a plain shell pane is still ignored');
});
