#!/usr/bin/env node
// The away report (W-639, W-640): node bin/away-report.mjs --since 2026-11-21 [--until 2026-11-28]
// Reads the running factory and writes ~/Code/plans/factory-away-report-<since>.md.
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { awayReport } from '../core/away-report.mjs';

const arg = k => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const since = arg('since') || (console.error('usage: away-report.mjs --since YYYY-MM-DD [--until YYYY-MM-DD]'), process.exit(2));
const state = await (await fetch('http://127.0.0.1:4848/api/state')).json();
const path = join(homedir(), 'Code/plans', `factory-away-report-${since}.md`);
writeFileSync(path, awayReport(state, { since, until: arg('until') || '9999' }) + '\n');
console.log(path);
