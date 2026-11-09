#!/usr/bin/env node
// stdio MCP entrypoint. Configure per seat: { "command": "node", "args": ["~/Code/repos/software-factory/bin/mcp.mjs"] }.
// The seat is the label of the herdr pane this process runs in (HERDR_PANE_ID), read on every call.
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcp } from '../mcp/server.mjs';
import { herdrRaw } from '../fleet/herdr.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const BASE = process.env.FACTORY_URL || 'http://127.0.0.1:4848';
const seatOf = async () => {
  const pane = process.env.HERDR_PANE_ID;
  if (!pane) throw new Error('Not in a herdr pane (no HERDR_PANE_ID), so this session has no factory seat.');
  const { panes } = await herdrRaw('pane', 'list');
  return panes.find(p => p.pane_id === pane)?.label || (() => { throw new Error(`Pane ${pane} has no label.`); })();
};
const api = {
  get: async (path, seat) => (await fetch(BASE + path, { headers: { 'x-seat': seat } })).json(),
  post: async (action, args, seat) => (await fetch(`${BASE}/api/actions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-factory': '1', 'x-seat': seat }, body: JSON.stringify({ action, args }) })).json(),
};
const handle = createMcp({ config, seatOf, api });
createInterface({ input: process.stdin }).on('line', async line => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const out = await handle(msg);
  if (out) process.stdout.write(JSON.stringify(out) + '\n');
});
