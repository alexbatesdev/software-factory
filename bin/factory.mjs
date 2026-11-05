#!/usr/bin/env node
// The software factory's seats. Run from a Terminals shell, outside the factory:
//   node bin/factory.mjs                         show each seat and what `up` would do
//   node bin/factory.mjs up                      start what's stopped, create what's missing (never restarts a running pane)
//   node bin/factory.mjs down [--with-local-head] [--yes]   stop every seat's process, keep its pane for `up`
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { herdrRaw as herdr } from '../fleet/herdr.mjs';
import { seatsOf, planFactory, planStop } from '../fleet/factory.mjs';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const [cmd = 'status', ...flags] = process.argv.slice(2);
const QUIET_SHELL = ['--env', 'DISABLE_AUTO_UPDATE=true'];
const home = p => String(p || '~/Code').replace(/^~/, os.homedir());
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pause = ms => new Promise(r => setTimeout(r, ms));
const seats = seatsOf(config);
const serverLabel = seats.find(s => s.expect === 'live.mjs')?.label;

const argvOf = async pane => ((await herdr('pane', 'process-info', '--pane', pane).catch(() => null))?.process_info?.foreground_processes || []).map(x => x.argv.join(' ')).join(' | ');

async function observe() {
  const [{ panes }, { agents }, { tabs }, { workspaces }] = await Promise.all(['pane', 'agent', 'tab', 'workspace'].map(k => herdr(k, 'list')));
  const ws = new Map(workspaces.map(w => [w.workspace_id, w])), tb = new Map(tabs.map(t => [t.tab_id, t])), ag = new Map(agents.map(a => [a.pane_id, a]));
  const out = await Promise.all(panes.map(async p => {
    return { pane: p.pane_id, label: p.label || '', agentName: ag.get(p.pane_id)?.name, status: ag.get(p.pane_id)?.agent_status, focused: p.focused,
      workspaceId: p.workspace_id, tabId: p.tab_id, workspace: ws.get(p.workspace_id)?.label || '', tab: tb.get(p.tab_id)?.label || '',
      argv: await argvOf(p.pane_id) };
  }));
  return { panes: out, tabs, workspaces };
}

// A pane for a new seat: the seat's tab if it has room (3 panes per tab), else a new tab.
async function slotFor(seat, { panes, tabs, workspaces }) {
  let w = workspaces.find(x => x.label === seat.workspace);
  if (!w) w = (await herdr('workspace', 'create', '--label', seat.workspace, '--cwd', home(seat.cwd), ...QUIET_SHELL, '--no-focus')).workspace;
  const t = tabs.find(x => x.workspace_id === w.workspace_id && x.label === seat.tab && x.pane_count < 3);
  const anchor = t && panes.find(p => p.tabId === t.tab_id);
  if (anchor) return (await herdr('pane', 'split', anchor.pane, '--direction', 'right', '--cwd', home(seat.cwd), ...QUIET_SHELL, '--no-focus')).pane.pane_id;
  const label = tabs.some(x => x.workspace_id === w.workspace_id && x.label === seat.tab) ? `${seat.tab} 2` : seat.tab;
  const created = await herdr('tab', 'create', '--workspace', w.workspace_id, '--label', label, '--cwd', home(seat.cwd), ...QUIET_SHELL, '--no-focus');
  return (await herdr('pane', 'list')).panes.find(p => p.tab_id === created.tab.tab_id).pane_id;
}

async function start(seat, pane) {
  if (seat.kind === 'shell') return herdr('pane', 'run', pane, `cd ${JSON.stringify(home(seat.cwd))} && ${seat.run.replace(/~\//g, `${os.homedir()}/`)}`);
  const args = seat.kind === 'codex' ? ['resume', seat.resume] : seat.role ? ['--agent', seat.role] : [];
  await pause(4000); // a fresh shell isn't ready for agent start straight away
  return herdr('agent', 'start', slug(seat.label), '--kind', seat.kind, '--pane', pane, '--', ...args);
}

// The sbx plugin acts on the focused pane, so focus the worker's tab and confirm before reconnecting.
async function reconnect(pane, seen) {
  const p = seen.panes.find(x => x.pane === pane);
  await herdr('workspace', 'focus', p.workspaceId); await herdr('tab', 'focus', p.tabId); await pause(1000);
  const ctx = (await herdr('plugin', 'action', 'invoke', 'doctor', '--plugin', 'sbx.sandbox')).context;
  if (ctx?.focused_pane_id !== pane) throw new Error(`focus landed on ${ctx?.focused_pane_id}, not ${pane}; not reconnecting`);
  await herdr('plugin', 'action', 'invoke', 'reconnect', '--plugin', 'sbx.sandbox');
}

async function up(apply) {
  const seen = await observe(), home0 = seen.panes.find(p => p.focused);
  for (const s of planFactory(seats, seen.panes)) {
    console.log(`${s.action.padEnd(16)} ${s.seat.label.padEnd(28)} ${s.seat.workspace} / ${s.seat.tab}${s.rename ? ' (label it)' : ''}: ${s.why}`);
    if (!apply || s.action === 'none' || s.action.startsWith('report')) { if (apply && s.rename && s.pane) await herdr('pane', 'rename', s.pane, s.seat.label); continue; }
    try {
      const pane = s.action === 'create' ? await slotFor(s.seat, seen) : s.pane;
      if (s.rename || s.action === 'create') await herdr('pane', 'rename', pane, s.seat.label);
      if (s.action === 'reconnect') await reconnect(pane, seen); else await start(s.seat, pane);
      console.log(`  done: ${pane}`);
    } catch (e) { console.log(`  failed: ${e.message}`); }
  }
  if (apply && home0) await herdr('workspace', 'focus', home0.workspaceId).catch(() => {});
  if (!apply) console.log('\nNothing changed. `up` carries this out, `down` stops every seat.');
}

async function down() {
  const seen = await observe(), plan = planStop(seats, seen.panes, { serverLabel, withLocalHead: flags.includes('--with-local-head') });
  const status = l => seen.panes.find(p => p.label === l)?.status || '-';
  for (const s of plan) console.log(`${s.action.padEnd(14)} ${s.seat.label.padEnd(28)} ${s.seat.kind.padEnd(6)} ${status(s.seat.label)}`);
  const busy = plan.filter(s => s.action === 'stop' && status(s.seat.label) === 'working').map(s => s.seat.label);
  if (busy.length) console.log(`\nStill working: ${busy.join(', ')}. Anything not in a handoff file is lost.`);
  if (!flags.includes('--yes')) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question('\nStop these? [y/N] ')).trim().toLowerCase() === 'y'; rl.close();
    if (!ok) return console.log('Nothing stopped.');
  }
  const failed = [];
  for (const s of plan.filter(x => x.action === 'stop')) {
    if (s.seat.kind === 'shell') await herdr('pane', 'send-keys', s.pane, 'ctrl+c');
    else { await herdr('pane', 'send-keys', s.pane, 'esc'); await pause(1000); await herdr('pane', 'send-text', s.pane, s.seat.kind === 'codex' ? '/quit' : '/exit'); await herdr('pane', 'send-keys', s.pane, 'enter'); }
    let stopped = false;
    for (let i = 0; i < 30 && !stopped; i++) { await pause(1000); stopped = planStop([s.seat], [{ pane: s.pane, label: s.seat.label, argv: await argvOf(s.pane) }], { withLocalHead: true })[0].action !== 'stop'; }
    console.log(`${stopped ? 'stopped' : 'STILL UP'.padEnd(7)} ${s.seat.label}${stopped ? '' : ' (look for a dialog in its pane)'}`);
    if (!stopped) failed.push(s.seat.label);
  }
  console.log(failed.length ? `\nStill running: ${failed.join(', ')}. Stop them by hand, then re-run down (it skips what's stopped).` : '\nEvery seat is stopped. Bring it back with `node bin/factory.mjs up`.');
}

if (cmd === 'down') await down();
else if (cmd === 'up' || cmd === 'status') await up(cmd === 'up');
else { console.error(`unknown command ${cmd}: status | up | down`); process.exit(2); }
