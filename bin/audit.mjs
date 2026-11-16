#!/usr/bin/env node
// On-demand Brakeman, as the built-rails Audit check runs it (Alex 11-16):
//   node bin/audit.mjs <branch|sha> [--vs main]   → its warnings, and with --vs, which are also on main
// Runs on the host in a throwaway worktree of ~/Code/repos/built-rails-a; results cache in data/audit/<sha>.json.
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrakeman } from '../sources/audit.mjs';
import { compareWarnings, compareText } from '../core/ci-compare.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'), checkout = join(homedir(), 'Code/repos/built-rails-a'), cacheDir = join(ROOT, 'data/audit');
const ref = process.argv[2], vs = process.argv.includes('--vs') ? process.argv[process.argv.indexOf('--vs') + 1] : null;
if (!ref) { console.error('usage: node bin/audit.mjs <branch|sha> [--vs main]'); process.exit(2); }
const resolve = r => { execFileSync('git', ['-C', checkout, 'fetch', '-q', 'origin', r]); return execFileSync('git', ['-C', checkout, 'rev-parse', /^[0-9a-f]{7,40}$/.test(r) ? r : `origin/${r}`]).toString().trim(); };
const show = r => `${r.sha.slice(0, 8)}: ${r.warnings.length} warning(s)${r.warnings.map(w => `\n  ${w.type} (${w.confidence}) ${w.file}:${w.line} ${w.fingerprint.slice(0, 10)}`).join('')}`;
const a = await runBrakeman({ checkout, sha: resolve(ref), cacheDir, log: m => console.error(m) });
console.log(`${ref} ${show(a)}`);
if (vs) { const b = await runBrakeman({ checkout, sha: resolve(vs), cacheDir, log: m => console.error(m) }); console.log(`${vs} ${show(b)}`); console.log(compareText('Brakeman', compareWarnings(a.warnings, b.warnings))); }
