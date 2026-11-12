// Fleet adapter for herdr panes and their sbx sandboxes. The server only uses list/deliver/send,
// so a cloud adapter (EC2 agents on the cloud agents dashboard) can replace this file.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFooter, layoutIssues, RESERVED, REVIEWS } from './status.mjs';
import { ORCHESTRATOR_TAB, WORKER_TAB as WORKER_TAB_LABEL } from './factory.mjs';

/**
 * @typedef {'working'|'idle'|'blocked'|'done'|'unknown'} AgentStatus
 * @typedef {{ ref: string, label: string, status: AgentStatus, now: string, sandbox: string|null, session: string|null, workspace: string, tab: string, jobs?: number|null }} Agent
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

/** Panes that are seats: any running an agent, plus a stream worker's pane whose agent died, so it can be restarted. */
export const seatPanes = (panes, agents) => { const has = new Set(agents.map(a => a.pane_id)); return panes.filter(p => has.has(p.pane_id) || WORKER.test(p.label || '')); };

/** @param {Record<string, ManualPair>} pairs @returns {Promise<Fleet>} */
export async function list(pairs = {}) {
  const [{ panes }, { agents }, { tabs }, { workspaces }] = await Promise.all([herdr('pane', 'list'), herdr('agent', 'list'), herdr('tab', 'list'), herdr('workspace', 'list')]);
  const byPane = new Map(agents.map(a => [a.pane_id, a]));
  const tabById = new Map(tabs.map(t => [t.tab_id, t]));
  const wsById = new Map(workspaces.map(w => [w.workspace_id, w]));
  const all = seatPanes(panes, agents).map(p => {
    const a = byPane.get(p.pane_id) || {};
    return { ref: p.pane_id, label: p.label || `${wsById.get(p.workspace_id)?.label || p.workspace_id} / ${tabById.get(p.tab_id)?.label || p.tab_id}`,
      status: ['working', 'idle', 'blocked', 'done'].includes(a.agent_status) ? a.agent_status : 'unknown',
      now: (a.terminal_title_stripped || p.terminal_title || '').replace(/^[^\w#]+/, ''), sandbox: null, session: a.agent_session?.value || null,
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

export async function herdrRaw(...args) {
  // herdr exits non-zero on an error and prints its JSON error on stderr; read it so callers see the code.
  const stdout = await run('herdr', args, { maxBuffer: 1 << 22, timeout: 20000 }).then(r => r.stdout, e => { if (String(e.stdout || e.stderr || "").trim().startsWith("{")) return e.stdout || e.stderr; throw e; });
  if (!String(stdout).trim()) return {}; // some commands (pane run) print nothing on success
  const j = JSON.parse(stdout);
  if (j.error) throw Object.assign(new Error(`herdr ${args.slice(0, 2).join(' ')}: ${j.error.code || j.error.message}`), { herdrError: j.error });
  return j.result;
}
