// Fleet adapter for herdr panes and their sbx sandboxes. The server only uses list/deliver/send,
// so a cloud adapter (EC2 agents on the cloud agents dashboard) can replace this file.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFooter, layoutIssues, RESERVED, REVIEWS, BOARD_ACTIONS } from './status.mjs';
import { ORCHESTRATOR_TAB, WORKER_TAB as WORKER_TAB_LABEL } from './factory.mjs';

/**
 * @typedef {'working'|'idle'|'blocked'|'done'|'unknown'} AgentStatus
 * @typedef {{ ref: string, label: string, status: AgentStatus, now: string, sandbox: string|null, workspace: string, tab: string, jobs?: number|null }} Agent
 *   `status` is the native turn state. `jobs` counts background shells still running (null when unknown).
 *   `ref` is the adapter's own handle (a herdr pane id here, an instance id for a cloud adapter).
 * @typedef {{ id: string, name: string, backend: string, paired: 'layout'|'convention'|'manual'|null,
 *             supervisor: Agent|null, worker: Agent|null }} Unit
 *   A unit is one supervisor and the worker it briefs. Work is delivered to the supervisor only.
 * @typedef {{ supervisor: string, worker: string }} ManualPair  agent labels, keyed by unit id
 * @typedef {{ units: Unit[], others: Agent[], layout: string[] }} Fleet
 *   `others`: agents outside any unit (reviews, one-offs). `layout`: departures from the agreed layout.
 */

// One workspace per stream with an "Orchestrator" tab and a "Worker" tab; the rest is in status.mjs.
const ORCH_TAB = new RegExp(`^${ORCHESTRATOR_TAB}$`, 'i'), WORKER_TAB = new RegExp(`^${WORKER_TAB_LABEL}$`, 'i');

const run = promisify(execFile);
const PLANS = path.join(process.env.HOME, 'Code/plans');
const SUP = /^sup:\s*(.+)$/i;
const WORKER = /^sbx(?::\s*|-)(.+)$/i;
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

async function herdr(...args) {
  const { stdout } = await run('herdr', args, { maxBuffer: 1 << 22 });
  return JSON.parse(stdout).result;
}

async function sandboxOf(paneId) {
  const { process_info } = await herdr('pane', 'process-info', '--pane', paneId);
  const argv = (process_info.foreground_processes || []).find(p => p.argv0 === 'sbx' || p.name === 'sbx')?.argv || [];
  return argv[0] === 'sbx' && argv.includes('--') ? argv[argv.indexOf('--') - 1] : null;
}

/** @param {Record<string, ManualPair>} pairs @returns {Promise<Fleet>} */
export async function list(pairs = {}) {
  const [{ panes }, { agents }, { tabs }, { workspaces }] = await Promise.all([herdr('pane', 'list'), herdr('agent', 'list'), herdr('tab', 'list'), herdr('workspace', 'list')]);
  const byPane = new Map(agents.map(a => [a.pane_id, a]));
  const tabById = new Map(tabs.map(t => [t.tab_id, t]));
  const wsById = new Map(workspaces.map(w => [w.workspace_id, w]));
  const all = panes.filter(p => byPane.has(p.pane_id)).map(p => {
    const a = byPane.get(p.pane_id);
    return { ref: p.pane_id, label: p.label || `${wsById.get(p.workspace_id)?.label || p.workspace_id} / ${tabById.get(p.tab_id)?.label || p.tab_id}`,
      status: ['working', 'idle', 'blocked', 'done'].includes(a.agent_status) ? a.agent_status : 'unknown',
      now: (a.terminal_title_stripped || p.terminal_title || '').replace(/^[^\w#]+/, ''), sandbox: null,
      workspace: wsById.get(p.workspace_id)?.label || '', tab: tabById.get(p.tab_id)?.label || '' };
  });
  await Promise.all(all.map(async a => { a.sandbox = await sandboxOf(a.ref).catch(() => null); }));
  // A finished turn may still own a background job; only the pane's visible footer shows it.
  await Promise.all(all.filter(a => ['done', 'idle'].includes(a.status)).map(async a => {
    try {
      const { stdout } = await run('herdr', ['pane', 'read', a.ref, '--source', 'visible', '--lines', '6'], { timeout: 5000 });
      Object.assign(a, parseFooter(stdout), { jobsSource: 'herdr pane read (visible footer)' });
    } catch { a.jobs = null; }
  }));
  const byLabel = new Map(all.map(a => [a.label, a]));
  const used = new Set();
  const units = [];
  const unit = (id, name, paired, supervisor, worker) => {
    for (const a of [supervisor, worker]) if (a) used.add(a.label);
    units.push({ id, name, backend: 'herdr', paired, supervisor: supervisor || null, worker: worker || null });
  };

  for (const [id, p] of Object.entries(pairs)) unit(id, id, 'manual', byLabel.get(p.supervisor), byLabel.get(p.worker));
  // A stream workspace: its Orchestrator tab holds the supervisor, its Worker tab the worker.
  for (const w of workspaces.filter(w => !RESERVED.includes(w.label) && w.label !== REVIEWS)) {
    const inWs = all.filter(a => a.workspace === w.label && !used.has(a.label));
    const sup = inWs.find(a => ORCH_TAB.test(a.tab)), wrk = inWs.find(a => WORKER_TAB.test(a.tab));
    if (sup || wrk) unit(slug(w.label), w.label, sup && wrk ? 'layout' : null, sup, wrk);
  }
  // Label convention for anything not laid out yet.
  const free = all.filter(a => !used.has(a.label));
  for (const s of free.filter(a => SUP.test(a.label))) {
    const name = s.label.match(SUP)[1];
    const w = free.find(x => WORKER.test(x.label) && !used.has(x.label) && slug(x.label.match(WORKER)[1]) === slug(name));
    unit(slug(name), name, w ? 'convention' : null, s, w);
  }
  for (const w of free.filter(a => WORKER.test(a.label) && !used.has(a.label))) unit(slug(w.label.match(WORKER)[1]), w.label.match(WORKER)[1], null, null, w);

  return { units, others: all.filter(a => !used.has(a.label)), layout: layoutIssues({ workspaces, tabs, agents: all, units }) };
}

async function type(agent, line, dryRun) {
  const steps = [];
  let readPath = line.path;
  if (agent.sandbox && line.path) {
    readPath = `/tmp/briefs/${path.basename(line.path)}`;
    steps.push(['sbx', 'exec', agent.sandbox, 'mkdir', '-p', '/tmp/briefs'], ['sbx', 'cp', line.path, `${agent.sandbox}:${readPath}`],
      ['sbx', 'exec', agent.sandbox, 'sudo', 'chown', '-R', 'agent:agent', '/tmp/briefs']);
  }
  const text = line.text.replace('{path}', readPath);
  steps.push(['herdr', 'pane', 'send-text', agent.ref, text], ['herdr', 'pane', 'send-keys', agent.ref, 'enter']);
  if (!dryRun) for (const [cmd, ...args] of steps) await run(cmd, args);
  return steps.map(s => s.join(' '));
}

/**
 * Hand a brief to the unit's supervisor, which briefs its own worker.
 * @param {Unit} unit @param {{ name: string, text: string }} brief @param {{ dryRun?: boolean }} opts
 * @returns {Promise<{ steps: string[], location: string }>}
 */
export async function deliver(unit, brief, { dryRun = true } = {}) {
  if (!unit.supervisor) throw new Error(`${unit.name} has no supervisor paired. Pair one before dispatching.`);
  const file = path.join(PLANS, brief.name);
  if (!dryRun) fs.writeFileSync(file, brief.text);
  const worker = unit.worker ? `your worker ${unit.worker.label}` : 'a worker you choose';
  const steps = [`write ${file}`, ...await type(unit.supervisor,
    { path: file, text: `Brief from Alex's triage board: read {path}, verify what it references, then brief ${worker} with it and supervise it as usual.` }, dryRun)];
  return { steps, location: file };
}

/** Send a one-line message to one agent (an answer to its question, a nudge). @param {Agent} agent */
export async function sendTo(agent, text, { dryRun = true } = {}) {
  return type(agent, { text }, dryRun);
}

/** Send a one-line message to the unit's supervisor. */
export async function send(unit, text, opts) {
  if (!unit.supervisor) throw new Error(`${unit.name} has no supervisor paired.`);
  return sendTo(unit.supervisor, text, opts);
}

// ---------- Run triage: a dedicated pane for a user-launched triage agent ----------
const pauseMs = ms => new Promise(r => setTimeout(r, ms));
export async function herdrRaw(...args) {
  // herdr exits non-zero on an error and prints its JSON error on stderr; read it so callers see the code.
  const stdout = await run('herdr', args, { maxBuffer: 1 << 22, timeout: 20000 }).then(r => r.stdout, e => { if (String(e.stdout || e.stderr || "").trim().startsWith("{")) return e.stdout || e.stderr; throw e; });
  if (!String(stdout).trim()) return {}; // some commands (pane run) print nothing on success
  const j = JSON.parse(stdout);
  if (j.error) throw Object.assign(new Error(`herdr ${args.slice(0, 2).join(' ')}: ${j.error.code || j.error.message}`), { herdrError: j.error });
  return j.result;
}

/**
 * Open a tab, start Claude in it, wait until it's ready, then prompt it with the brief. `step(name, data)` is
 * called after each step so the caller can persist progress. Throws {uncertain:true, pane} once a pane exists
 * and a later step can't be confirmed; throws plain errors before that.
 */
export async function launchTriage({ runId, briefPath, model = 'sonnet' }, step) {
  // Every agent the board spawns goes in Board Actions, one tab per run, so no tab passes 3 panes.
  const { workspaces: all } = await herdrRaw('workspace', 'list');
  let ws = all.find(w => w.label === BOARD_ACTIONS);
  if (!ws) ws = (await herdrRaw('workspace', 'create', '--label', BOARD_ACTIONS, '--cwd', path.join(process.env.HOME, 'Code'), '--no-focus')).workspace;
  if (!ws?.workspace_id) throw new Error(`Couldn't find or create the ${BOARD_ACTIONS} workspace.`);
  const label = `triage-run ${runId}`;
  // Recorded before the call: from here on, any unknown outcome means a tab may exist, so it's uncertain, never retried.
  await step('create-attempt', { label, workspace: ws.label });
  let created;
  try { created = await herdrRaw('tab', 'create', '--workspace', ws.workspace_id, '--label', label, '--cwd', path.join(process.env.HOME, 'Code'), '--no-focus'); }
  catch (e) { throw Object.assign(new Error(`tab create: ${e.message}`), { uncertain: !e.herdrError }); }
  const tabId = created.tab?.tab_id;
  await step('tab', { tab: tabId });
  let pane;
  try { pane = (await herdrRaw('pane', 'list')).panes.find(p => p.tab_id === tabId)?.pane_id; } catch { pane = null; }
  if (!pane) throw Object.assign(new Error(`Tab ${tabId} was created but its pane couldn't be read.`), { uncertain: true, tab: tabId });
  await step('pane', { tab: tabId, pane, workspace: ws.label });
  const uncertain = msg => Object.assign(new Error(msg), { uncertain: true, pane });
  await pauseMs(4000); // a fresh pane's shell isn't ready for agent start straight away
  try { await herdrRaw('agent', 'start', `triage-run-${runId.toLowerCase()}`, '--kind', 'claude', '--pane', pane, '--', '--model', model); }
  catch (e) { throw uncertain(`agent start: ${e.message}`); }
  await step('agent-start', { pane });
  let agent = null;
  for (let i = 0; i < 45; i++) {
    await pauseMs(2000);
    try { agent = (await herdrRaw('agent', 'get', pane)).agent; } catch { agent = null; }
    if (agent && ['idle', 'done'].includes(agent.agent_status) && agent.interactive_ready !== false) break;
    agent = null;
  }
  if (!agent) throw uncertain('The agent never became ready to take the brief.');
  await step('agent-ready', { session: agent.agent_session?.value, terminal: agent.terminal_id });
  let res;
  try { res = await herdrRaw('agent', 'prompt', pane, `Triage run ${runId} from the board: read ${briefPath} and execute it now.`); }
  catch (e) { throw uncertain(`prompt: ${e.message}`); }
  if (res?.type !== 'agent_prompted') throw uncertain('herdr did not confirm the prompt.');
  return { pane, tab: tabId, terminal: agent.terminal_id, session: agent.agent_session?.value, workspace: ws.label };
}

/** The triage agent's current state, or null if its pane is gone. */
export async function agentInfo(pane) {
  let a;
  try { a = (await herdrRaw('agent', 'get', pane)).agent; } catch (e) {
    if (!['pane_not_found', 'agent_not_found'].includes(e.herdrError?.code)) return null;
    // No agent can still mean a live pane with a bare shell; only a missing pane counts as gone.
    try { await herdrRaw('pane', 'get', pane); return null; } catch (e2) { return e2.herdrError?.code === 'pane_not_found' ? { gone: true } : null; }
  }
  let jobs = null;
  try { jobs = parseFooter((await run('herdr', ['pane', 'read', pane, '--source', 'visible', '--lines', '6'], { timeout: 5000 })).stdout).jobs; } catch { /* unknown */ }
  return { status: a.agent_status, session: a.agent_session?.value, terminal: a.terminal_id, jobs };
}

/** Find an uncertain run's tab by its unique label, so it can be reconciled instead of relaunched. */
export async function findRunPane(label) {
  try {
    const { tabs } = await herdrRaw('tab', 'list');
    const t = tabs.find(x => x.label === label);
    if (!t) return null;
    const p = (await herdrRaw('pane', 'list')).panes.find(x => x.tab_id === t.tab_id);
    return p ? { tab: t.tab_id, pane: p.pane_id } : { tab: t.tab_id, pane: null };
  } catch { return null; }
}

/** Close a pane the board itself created for a run. */
export async function closePane(pane) { await herdrRaw('pane', 'close', pane); }
