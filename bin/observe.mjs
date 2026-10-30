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
import { sourceCommands } from '../core/correlate.mjs';
import { parseAcs } from '../core/derive.mjs';
import { inboxCommands } from '../core/inbox.mjs';
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
const summarize = (name, cmds) => {
  const by = cmds.reduce((m, c) => ({ ...m, [c.kind]: (m[c.kind] || 0) + 1 }), {});
  console.log(`  ${name} source commands V2 would append: ${JSON.stringify(by)}`);
  for (const c of cmds.filter(c => c.kind === 'observe_source').slice(0, 15)) console.log(`   observe ${c.payload.id} ${String(c.payload.title).slice(0, 60)}`);
};
if (got.github) summarize('github', sourceCommands(state, projectPrs(got.github.lines, got.github.own).prs, 'pr', parseAcs, { mutationBranch: config.mutationBranch, exclude: config.autoDispatch?.exclude }));
if (got.teamwork) {
  const tasks = projectTasks(got.teamwork, process.env.TEAMWORK_SITE);
  console.log(`teamwork: ${got.teamwork.length} tasks read, ${tasks.size} work items`);
  summarize('teamwork', sourceCommands(state, tasks, 'teamwork', parseAcs));
}
if (got.fleet) console.log(`fleet: ${got.fleet.units.length} stream units, ${got.fleet.others.length} other agents, ${got.fleet.layout.length} layout issues`);

const supervisors = Object.keys(config.routing.supervisors);
const seats = [...supervisors, config.routing.questionsRouter, ...(config.factory?.seats || []).map(x => x.label)];
const since = state.legacy.notifier?.activatedAt;
const inbox = inboxCommands(state, { supervisors, seats, router: config.routing.questionsRouter, cutoff: since, answersSince: config.notify?.answersSince || since }, got.fleet && { units: got.fleet.units, now: Date.now(), watches: {} });
console.log(`inbox: messages V2 would create now: ${inbox.cmds.length}`);
for (const c of inbox.cmds) console.log(`   -> ${c.payload.to}: ${JSON.stringify(c.payload.about)}`);
