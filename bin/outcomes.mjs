#!/usr/bin/env node
// Outcomes by agent (W-558): `node bin/outcomes.mjs [--since <iso>] [--until <iso>]` writes ~/Code/plans/factory-outcomes-<until>.md
// from the running factory's state. Read-only.
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { outcomes, outcomesMarkdown, codexSinceOf } from '../core/outcomes.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const config = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'config.json'), 'utf8'));
const until = arg('until') || new Date().toISOString(), since = arg('since') || new Date(Date.parse(until) - 7 * 86400000).toISOString();
const state = await (await fetch('http://127.0.0.1:4848/api/state')).json();
const cfg = { since, until, codexSince: codexSinceOf(config) };
const out = join(homedir(), 'Code/plans', `factory-outcomes-${until.slice(0, 10)}.md`);
writeFileSync(out, outcomesMarkdown(outcomes(state, cfg), cfg));
console.log(out);
