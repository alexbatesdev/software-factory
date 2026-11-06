// What a unit's pane is actually doing. herdr's agent_status is the agent's *turn* state: "done" means the
// turn ended, not that the assigned task finished. Pure functions; the herdr adapter supplies the inputs.

/**
 * Claude Code's footer lists running background jobs ("· 1 shell"). Read from herdr's own visible-screen read,
 * not a transcript. Returns {jobs: n}, or {jobs: null} when no footer is on screen (unknown, not zero).
 */
export function parseFooter(text) {
  const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
  const footer = lines.reverse().find(l => /auto mode|⏵⏵|shift\+tab|bypass permissions|accept edits/i.test(l));
  if (!footer) return { jobs: null };
  const m = footer.match(/(\d+)\s+(?:background\s+)?shells?\b/i);
  return { jobs: m ? Number(m[1]) : 0 };
}

/**
 * The state to show, combining the native turn state with the board's record of the unit's active work.
 * Never reports a task as done: completion comes only from a `done` report on the work record.
 */
export function agentState(a, { activeWork }) {
  const s = a.status;
  if (s === 'working') return { key: 'working', text: 'working' };
  if (s === 'blocked') return { key: 'blocked', text: 'blocked: waiting for a person at a dialog' };
  if (['done', 'idle'].includes(s)) {
    if (a.jobs > 0) return { key: 'waiting', text: `turn ended; ${a.jobs} background shell${a.jobs === 1 ? '' : 's'} still running` };
    if (activeWork > 0) return { key: 'turn-ended', text: `turn ended (herdr: ${s}); assigned work still active` };
    return { key: 'idle', text: 'idle' };
  }
  return { key: 'unknown', text: s || 'unknown' };
}

// The agreed herdr layout, also in ~/Code/CLAUDE.md ("The herdr layout").
export const BOARD_ACTIONS = 'Board Actions';
export const SERVICES = 'Services';
export const RESERVED = ['Main', BOARD_ACTIONS, 'Terminals', SERVICES];
export const REVIEWS = 'Trusted reviews';
// A host stream's supervisor spawns one worker per job in that repo's workspace (TB-159), so it has no Worker tab.
export const HOST = 'Host';
const BOARD_SPAWNED = /^triage-run\b/i;

/** Departures from the layout, one sentence each. Pure: callers pass herdr's workspaces and tabs and the labelled agents. */
export function layoutIssues({ workspaces, tabs, agents, units }) {
  const wsLabel = new Map(workspaces.map(w => [w.workspace_id, w.label]));
  const out = [];
  // The 3-pane limit keeps agent-built layouts readable; Alex arranges Terminals himself.
  for (const t of tabs.filter(t => t.pane_count > 3 && wsLabel.get(t.workspace_id) !== 'Terminals')) out.push(`${wsLabel.get(t.workspace_id) || t.workspace_id} tab "${t.label}" has ${t.pane_count} panes; the limit is 3.`);
  if (workspaces.some(w => w.label === 'Assistants')) out.push('An "Assistants" workspace exists; its sessions belong in Main.');
  for (const a of agents.filter(a => BOARD_SPAWNED.test(a.label) && a.workspace !== BOARD_ACTIONS)) out.push(`"${a.label}" was spawned by the board but is in ${a.workspace || 'no workspace'}, not ${BOARD_ACTIONS}.`);
  for (const u of units.filter(u => u.paired !== 'layout' && u.supervisor?.workspace !== HOST)) out.push(`${u.name} isn't in its own workspace with Orchestrator and Worker tabs.`);
  for (const a of agents.filter(a => a.workspace === 'Terminals')) out.push(`Agent "${a.label}" is running in Terminals, which is Alex's space.`);
  return out;
}
