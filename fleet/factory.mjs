// The software factory's seats, and what it takes to bring each one up. Planners are pure; the effects take herdr as an argument.
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { streamBusy } from '../core/recycle.mjs';
import { exitChoice } from '../hosts/sbx.mjs';
export const ORCHESTRATOR_TAB = 'Orchestrator', WORKER_TAB = 'Worker', TERMINALS = 'Terminals';

/** The agent a seat runs: a stream's worker runs its `routing.supervisors[sup].agent` (default claude); every other seat is Claude. */
export const agentOf = (config, label) => Object.values(config.routing?.supervisors || {}).find(s => s.worker === label)?.agent
  || (config.factory?.seats || []).find(s => s.label === label && s.kind === 'codex')?.kind || 'claude';
// Each agent's own quit command.
export const QUIT = { claude: '/exit', codex: '/quit' };

/** Fixed seats from `config.factory.seats`, plus a supervisor and sbx worker per stream in `routing.supervisors`. */
export function seatsOf(config) {
  const was = label => Object.entries(config.routing?.renamed || {}).filter(([, to]) => to === label).map(([from]) => from);
  const streams = Object.entries(config.routing?.supervisors || {}).filter(([, s]) => s.workspace).flatMap(([label, s]) => [
    { label, kind: 'claude', role: 'stream-supervisor', workspace: s.workspace, tab: ORCHESTRATOR_TAB },
    ...(s.worker ? [{ label: s.worker, kind: 'sbx', agent: agentOf(config, s.worker), workspace: s.workspace, tab: WORKER_TAB }] : []),
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
// Seats marked `stays` (local-head, the board developer, the agent unblocker and its alert script) outlive `down` (Alex, 11-09).
export function planStop(seats, panes, { serverLabel, all = false } = {}) {
  const rank = s => s.kind === 'sbx' ? 0 : s.role === 'stream-supervisor' ? 1 : s.label === serverLabel ? 3 : s.label === 'local-head' ? 4 : 2;
  return seats.filter(s => all || !s.stays)
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

/**
 * Claude seats due their daily fresh start (Alex, 11-09: seats that ran 3 to 4 days got expensive). sbx workers recycle
 * between jobs instead (core/recycle.mjs).
 * @param agents [{label, ref, status}] from the fleet read @param state {messages, work}
 * @param opts {now, hourUtc, enabled, done: {label: 'YYYY-MM-DD' last restarted}} @returns [{seat, pane}]
 */
export function planSeatRestarts(seats, agents, state, { now, hourUtc = 10, enabled = false, done = {}, toolsOf = null, toolsDone = {} }) {
  const day = String(now).slice(0, 10), daily = new Date(now).getUTCHours() === hourUtc;
  if (!enabled) return [];
  // A seat whose role's board tools changed since it started (W-431) restarts at its next gap, whatever the hour.
  const due = s => (daily && done[s.label] !== day) || (!!toolsOf && toolsDone[s.label] !== toolsOf(s));
  return seats.filter(s => s.kind === 'claude' && !s.stays && due(s)).flatMap(seat => {
    const a = agents.find(x => x.label === seat.label);
    if (!a || !['idle', 'done'].includes(a.status)) return [];
    if (Object.values(state.messages).some(m => m.to === seat.label && !m.ackedAt)) return [];
    if (seat.role === 'stream-supervisor' && streamBusy(state.work, seat.label)) return [];
    return [{ seat, pane: a.ref }];
  });
}

const pause = ms => new Promise(r => setTimeout(r, ms));
const home = p => String(p || '~/Code').replace(/^~/, os.homedir());
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** The pane's foreground command lines, joined. */
export const argvOf = async (herdr, pane) => ((await herdr('pane', 'process-info', '--pane', pane).catch(() => null))?.process_info?.foreground_processes || []).map(x => (x.argv || []).join(' ')).join(' | ');

/** Start a seat's process in its pane, as `factory.mjs up` does. */
export async function startSeat(seat, pane, herdr) {
  if (seat.kind === 'shell') return herdr('pane', 'run', pane, `cd ${JSON.stringify(home(seat.cwd))} && ${seat.run.replace(/~\//g, `${os.homedir()}/`)}`);
  const args = seat.kind === 'codex' ? ['resume', seat.resume] : seat.role ? ['--agent', seat.role] : [];
  await pause(4000); // a fresh shell isn't ready for agent start straight away
  return herdr('agent', 'start', slug(seat.label), '--kind', seat.kind, '--pane', pane, '--', ...args);
}

/** Stop a seat's process, keeping its pane; true once it is down within 30 s. */
export async function stopSeat(seat, pane, herdr) {
  if (seat.kind === 'shell') await herdr('pane', 'send-keys', pane, 'ctrl+c');
  else { await herdr('pane', 'send-keys', pane, 'esc'); await pause(1000); await herdr('pane', 'send-text', pane, QUIT[seat.agent || seat.kind] || QUIT.claude); await herdr('pane', 'send-keys', pane, 'enter'); }
  for (let i = 0; i < 30; i++) {
    await pause(1000);
    if (!running(seat, await argvOf(herdr, pane))) return true;
    // Claude's "Background work is running" dialog: Exit and stop tasks (Alex, 11-06).
    if (seat.kind !== 'claude') continue;
    const screen = await promisify(execFile)('herdr', ['pane', 'read', pane, '--source', 'visible'], { timeout: 5000 }).then(r => r.stdout, () => '');
    const key = exitChoice(screen);
    if (key) await herdr('pane', 'send-keys', pane, key);
  }
  return false;
}
