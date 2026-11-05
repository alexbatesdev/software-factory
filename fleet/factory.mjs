// The software factory's seats, and what it takes to bring each one up. Pure: bin/factory.mjs does the herdr calls.
export const ORCHESTRATOR_TAB = 'Orchestrator', WORKER_TAB = 'Worker', TERMINALS = 'Terminals';

/** Fixed seats from `config.factory.seats`, plus a supervisor and sbx worker per stream in `routing.supervisors`. */
export function seatsOf(config) {
  const streams = Object.entries(config.routing?.supervisors || {}).filter(([, s]) => s.workspace).flatMap(([label, s]) => [
    { label, kind: 'claude', role: 'stream-supervisor', workspace: s.workspace, tab: ORCHESTRATOR_TAB },
    ...(s.worker ? [{ label: s.worker, kind: 'sbx', workspace: s.workspace, tab: WORKER_TAB }] : []),
  ]);
  return [...(config.factory?.seats || []).filter(s => s.enabled !== false), ...streams];
}

const running = (seat, argv) => ({
  shell: () => argv.includes(seat.expect),
  claude: () => /(^|[\s/])claude\b/.test(argv),
  codex: () => /(^|[\s/])codex\b/.test(argv),
  sbx: () => /\bsbx exec\b/.test(argv),
})[seat.kind]();

/**
 * @param seats from seatsOf
 * @param panes [{pane, label, agentName, workspace, tab, argv}] argv: the pane's foreground command lines, joined
 * @returns [{seat, pane, action, rename, why}] action: none | run | start | reconnect | create | report-*
 */
export function planFactory(seats, panes) {
  return seats.map(seat => {
    const p = panes.find(x => x.label === seat.label) || panes.find(x => !x.label && x.agentName === seat.label);
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
    .map(seat => ({ seat, p: panes.find(x => x.label === seat.label) }))
    .sort((a, b) => rank(a.seat) - rank(b.seat))
    .map(({ seat, p }) => ({ seat, pane: p?.pane, action: !p ? 'skip-missing' : running(seat, p.argv) ? 'stop' : 'skip-stopped' }));
}
