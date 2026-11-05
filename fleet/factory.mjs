// The software factory's seats, and what it takes to bring each one up. Planners are pure; slotFor takes herdr as an argument.
export const ORCHESTRATOR_TAB = 'Orchestrator', WORKER_TAB = 'Worker', TERMINALS = 'Terminals';

/** Fixed seats from `config.factory.seats`, plus a supervisor and sbx worker per stream in `routing.supervisors`. */
export function seatsOf(config) {
  const was = label => Object.entries(config.routing?.renamed || {}).filter(([, to]) => to === label).map(([from]) => from);
  const streams = Object.entries(config.routing?.supervisors || {}).filter(([, s]) => s.workspace).flatMap(([label, s]) => [
    { label, kind: 'claude', role: 'stream-supervisor', workspace: s.workspace, tab: ORCHESTRATOR_TAB },
    ...(s.worker ? [{ label: s.worker, kind: 'sbx', workspace: s.workspace, tab: WORKER_TAB }] : []),
  ]);
  return [...(config.factory?.seats || []).filter(s => s.enabled !== false), ...streams].map(s => ({ ...s, was: was(s.label) }));
}

// A renamed seat's pane may still carry its old label until up relabels it.
const paneOf = (seat, panes) => panes.find(x => x.label === seat.label) || panes.find(x => (seat.was || []).includes(x.label));

const running = (seat, argv) => ({
  shell: () => argv.includes(seat.expect),
  claude: () => /(^|[\s/])claude\b/.test(argv),
  codex: () => /(^|[\s/])codex\b/.test(argv),
  sbx: () => /\bsbx exec\b/.test(argv),
})[seat.kind]();

/**
 * @param seats from seatsOf
 * @param panes [{pane, label, agentName, workspace, tab, argv}] argv: the pane's foreground command lines, joined
 * @returns [{seat, pane, action, rename, why}] action: none | run | start | reconnect | adopt | create | report-*
 */
export function planFactory(seats, panes) {
  return seats.map(seat => {
    const p = paneOf(seat, panes) || panes.find(x => !x.label && x.agentName === seat.label);
    if (!p && seat.kind === 'sbx' && seat.sandbox) return { seat, action: 'adopt', why: `pane gone; moving sandbox ${seat.sandbox} into a new pane in ${seat.workspace} / ${seat.tab}` };
    if (!p) return seat.workspace === TERMINALS || seat.kind === 'sbx'
      ? { seat, action: 'report-missing', why: seat.kind === 'sbx' ? 'no worker pane; creating a sandbox is Alex\'s call' : 'Terminals is Alex\'s; start it there yourself' }
      : { seat, action: 'create', why: `new pane in ${seat.workspace} / ${seat.tab}` };
    const base = { seat, pane: p.pane, rename: p.label !== seat.label };
    if (p.workspace !== seat.workspace) return { ...base, action: 'report-misplaced', why: `in ${p.workspace}, the manifest says ${seat.workspace}` };
    if (!running(seat, p.argv) && seat.workspace === TERMINALS) return { ...base, action: 'report-stopped', why: `stopped; Terminals is Alex's, run \`${seat.run}\` there` };
    if (!running(seat, p.argv)) return { ...base, action: { shell: 'run', sbx: 'reconnect' }[seat.kind] || 'start', why: 'pane is up, its process is not' };
    if (seat.role && !p.argv.includes(`--agent ${seat.role}`)) return { ...base, action: 'report-role', why: `running without --agent ${seat.role}; restart it fresh to load the role` };
    return { ...base, action: 'none', why: 'running' };
  });
}

/**
 * Tear-down order: sbx workers, supervisors, the other seats, the board server, then local-head if asked.
 * @returns [{seat, pane, action}] action: stop | skip-stopped | skip-missing
 */
export function planStop(seats, panes, { serverLabel, withLocalHead = false } = {}) {
  const rank = s => s.kind === 'sbx' ? 0 : s.role === 'stream-supervisor' ? 1 : s.label === serverLabel ? 3 : s.label === 'local-head' ? 4 : 2;
  return seats.filter(s => withLocalHead || s.label !== 'local-head')
    .map(seat => ({ seat, p: paneOf(seat, panes) }))
    .sort((a, b) => rank(a.seat) - rank(b.seat))
    .map(({ seat, p }) => ({ seat, pane: p?.pane, action: !p ? 'skip-missing' : running(seat, p.argv) ? 'stop' : 'skip-stopped' }));
}

const QUIET_SHELL = ['--env', 'DISABLE_AUTO_UPDATE=true'];

/**
 * A pane for a new seat: the seat's tab if it has room (3 panes per tab), else a new tab. Reads herdr fresh each call,
 * so seats created in one run share the workspace the first one made; a new workspace's own first tab becomes the seat's tab.
 * @param herdr (...args) => parsed herdr result @returns pane id
 */
export async function slotFor(seat, herdr, cwd = seat.cwd) {
  const [{ panes }, { tabs }, { workspaces }] = await Promise.all(['pane', 'tab', 'workspace'].map(k => herdr(k, 'list')));
  const firstPane = async tabId => (await herdr('pane', 'list')).panes.find(p => p.tab_id === tabId).pane_id;
  let w = workspaces.find(x => x.label === seat.workspace);
  if (!w) {
    w = (await herdr('workspace', 'create', '--label', seat.workspace, '--cwd', cwd, ...QUIET_SHELL, '--no-focus')).workspace;
    const t = (await herdr('tab', 'list')).tabs.find(x => x.workspace_id === w.workspace_id);
    await herdr('tab', 'rename', t.tab_id, seat.tab);
    return firstPane(t.tab_id);
  }
  const t = tabs.find(x => x.workspace_id === w.workspace_id && x.label === seat.tab && x.pane_count < 3);
  const anchor = t && panes.find(p => p.tab_id === t.tab_id);
  if (anchor) return (await herdr('pane', 'split', anchor.pane_id, '--direction', 'right', '--cwd', cwd, ...QUIET_SHELL, '--no-focus')).pane.pane_id;
  const label = tabs.some(x => x.workspace_id === w.workspace_id && x.label === seat.tab) ? `${seat.tab} 2` : seat.tab;
  const created = await herdr('tab', 'create', '--workspace', w.workspace_id, '--label', label, '--cwd', cwd, ...QUIET_SHELL, '--no-focus');
  return firstPane(created.tab.tab_id);
}
