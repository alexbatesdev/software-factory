#!/usr/bin/env node
// The software factory's seats. Run from a Terminals shell, outside the factory:
//   node bin/factory.mjs                         show each seat and what `up` would do
//   node bin/factory.mjs up                      start what's stopped, create what's missing (never restarts a running pane)
//   node bin/factory.mjs down [--with-local-head] [--yes]   stop every seat's process, keep its pane for `up`
//   node bin/factory.mjs rename                  with the server down: move the board's records to routing.renamed's new labels
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { herdrRaw as herdr } from '../fleet/herdr.mjs';
import { seatsOf, planFactory, planStop, slotFor } from '../fleet/factory.mjs';
import { bridgeLine, adoptSandbox, sandboxOf, restoreBaseline } from '../hosts/sbx.mjs';
import { openStore } from '../core/store.mjs';

const ROOT = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const [cmd = 'status', ...flags] = process.argv.slice(2);
const home = p => String(p || '~/Code').replace(/^~/, os.homedir());
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pause = ms => new Promise(r => setTimeout(r, ms));
// Each worker's sandbox, kept while its pane exists, so a worker whose pane herdr lost can be adopted into a new one.
const SANDBOXES = path.join(ROOT, 'data/sandboxes.json');
const known = (() => { try { return JSON.parse(fs.readFileSync(SANDBOXES, 'utf8')); } catch { return {}; } })();
const seats = seatsOf(config).map(s => s.kind === 'sbx' && known[s.label] ? { ...s, sandbox: known[s.label] } : s);
const serverLabel = seats.find(s => s.expect === 'live.mjs')?.label;

const argvOf = async pane => ((await herdr('pane', 'process-info', '--pane', pane).catch(() => null))?.process_info?.foreground_processes || []).map(x => (x.argv || []).join(' ')).join(' | ');

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

async function start(seat, pane) {
  if (seat.kind === 'shell') return herdr('pane', 'run', pane, `cd ${JSON.stringify(home(seat.cwd))} && ${seat.run.replace(/~\//g, `${os.homedir()}/`)}`);
  const args = seat.kind === 'codex' ? ['resume', seat.resume] : seat.role ? ['--agent', seat.role] : [];
  await pause(4000); // a fresh shell isn't ready for agent start straight away
  return herdr('agent', 'start', slug(seat.label), '--kind', seat.kind, '--pane', pane, '--', ...args);
}

async function remember(seen) {
  for (const s of seats.filter(x => x.kind === 'sbx')) {
    const p = seen.panes.find(x => x.label === s.label || s.was.includes(x.label));
    const box = p && await sandboxOf(p.pane);
    if (box) known[s.label] = s.sandbox = box;
  }
  fs.writeFileSync(SANDBOXES, JSON.stringify(known, null, 2) + '\n');
}

// The plugin's own start line (HERDR_AGENT set, so herdr sees the agent's status); its start mode reuses an existing sandbox.
const attach = async pane => herdr('pane', 'run', pane, await bridgeLine({ ref: pane }));

async function up(apply) {
  const seen = await observe(), home0 = seen.panes.find(p => p.focused);
  await remember(seen);
  for (const s of planFactory(seats, seen.panes)) {
    console.log(`${s.action.padEnd(16)} ${s.seat.label.padEnd(28)} ${s.seat.workspace} / ${s.seat.tab}${s.rename ? ' (label it)' : ''}: ${s.why}`);
    if (!apply || s.action === 'none' || s.action.startsWith('report')) { if (apply && s.rename && s.pane) await herdr('pane', 'rename', s.pane, s.seat.label); continue; }
    try {
      const fresh = ['create', 'adopt'].includes(s.action);
      const pane = fresh ? await slotFor(s.seat, herdr, home(s.seat.cwd)) : s.pane;
      if (s.rename || fresh) await herdr('pane', 'rename', pane, s.seat.label);
      if (s.action === 'adopt') {
        const { panes } = await herdr('pane', 'list');
        await adoptSandbox(s.seat.sandbox, pane, panes.find(p => p.pane_id === pane).workspace_id, { livePanes: panes.map(p => p.pane_id) });
        await restoreBaseline(s.seat.sandbox);
      }
      if (['reconnect', 'adopt'].includes(s.action)) await attach(pane); else await start(s.seat, pane);
      console.log(`  done: ${pane}`);
    } catch (e) { console.log(`  failed: ${e.message}`); }
  }
  if (apply && home0) await herdr('workspace', 'focus', home0.workspaceId).catch(() => {});
  if (!apply) console.log('\nNothing changed. `up` carries this out, `down` stops every seat.');
}

async function down() {
  const seen = await observe();
  await remember(seen);
  const plan = planStop(seats, seen.panes, { serverLabel, withLocalHead: flags.includes('--with-local-head') });
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

async function rename() {
  const server = planStop(seats.filter(s => s.label === serverLabel), (await observe()).panes)[0];
  if (server?.action === 'stop') { console.log(`The board server (${serverLabel}) is running; run \`down\` first.`); process.exit(1); }
  const db = path.join(ROOT, 'data/factory.db'), backup = path.join(ROOT, 'data/spamton-factory-pre-rename.db');
  fs.copyFileSync(db, backup);
  const store = openStore(db, { supervisors: Object.keys(config.routing.supervisors) });
  for (const [from, to] of Object.entries(config.routing.renamed || {}).filter(([k]) => k !== '_doc')) {
    if (!JSON.stringify(store.state).includes(JSON.stringify(from))) { console.log(`skip  ${from}: not on the board`); continue; }
    store.append({ kind: 'rename_seat', payload: { from, to } }, { now: new Date().toISOString(), by: 'factory.mjs rename' });
    console.log(`moved ${from} -> ${to}`);
  }
  const same = JSON.stringify(store.replay()) === JSON.stringify(store.state);
  store.close();
  console.log(same ? `Replay matches. Backup: ${backup}` : `REPLAY DIFFERS: restore ${backup} over ${db} before starting the server.`);
  if (!same) process.exit(1);
}

if (cmd === 'down') await down();
else if (cmd === 'rename') await rename();
else if (cmd === 'up' || cmd === 'status') await up(cmd === 'up');
else { console.error(`unknown command ${cmd}: status | up | down | rename`); process.exit(2); }
