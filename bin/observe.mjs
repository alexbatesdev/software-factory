#!/usr/bin/env node
// One read-only pass: import V1's state.json, read GitHub, Teamwork and the fleet, and report what V2 would decide.
// Writes nothing anywhere. Run with: node --env-file="$HOME/Code/teamwork mini mcp/.env" bin/observe.mjs
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../core/store.mjs';
import { importCommands } from '../core/import.mjs';
import { projectPrs, projectTasks, headCommands, recordPrKey } from '../core/observe.mjs';
import { TERMINAL } from '../core/work.mjs';
import { readPrLines } from '../sources/github.mjs';
import { readTasks } from '../sources/teamwork.mjs';
import { list as readFleet } from '../fleet/herdr.mjs';

const V1 = join(homedir(), 'Code/triage-board');
const config = JSON.parse(readFileSync(join(V1, 'config.json'), 'utf8'));
const store = openStore();
for (const c of importCommands(JSON.parse(readFileSync(join(V1, 'state.json'), 'utf8')), store.state)) store.append(c, { now: new Date().toISOString(), by: 'import' });
const state = store.state, owner = config.githubOwner;

const settle = (name, p) => p.then(v => [name, v, null], e => [name, null, e]);
const tracked = [...new Set(Object.values(state.work).filter(w => !TERMINAL.includes(w.phase)).map(w => recordPrKey(w, owner)).filter(Boolean))];
const results = await Promise.all([settle('github', readPrLines({ owner, tracked })), settle('teamwork', readTasks()), settle('fleet', readFleet(state.legacy.pairs))]);
const got = Object.fromEntries(results.map(([n, v, e]) => { if (e) console.log(`${n}: FAILED ${String(e.message).slice(0, 200)}`); return [n, v]; }));

if (got.github) {
  const { prs, heads } = projectPrs(got.github.lines, got.github.own);
  console.log(`github: ${got.github.own.size} own open PRs, ${prs.size} PR items, ${heads.size} heads read (${tracked.length} tracked)`);
  const cmds = headCommands(state, heads, { owner, now: new Date().toISOString(), standingWaiver: config.standingWaiver });
  console.log(`  head commands V2 would append: ${cmds.length}`);
  for (const c of cmds) { const w = state.work[c.target]; console.log(`   ${c.target} ${c.kind} ${c.payload.sha || ''} (board head ${w.head || '-'}, verified ${w.headVerified?.via || '-'}@${w.headVerified?.sha || '-'})`); }
}
if (got.teamwork) console.log(`teamwork: ${got.teamwork.length} tasks read, ${projectTasks(got.teamwork, process.env.TEAMWORK_SITE).size} work items`);
if (got.fleet) console.log(`fleet: ${got.fleet.units.length} stream units, ${got.fleet.others.length} other agents, ${got.fleet.layout.length} layout issues`);
