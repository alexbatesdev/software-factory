// W-561: host-side usage reads. A seat's Claude sessions on this Mac, summed over a window (supervisors' weekly totals).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile), PY = join(dirname(fileURLToPath(import.meta.url)), 'usage.py');

/** {model: tokens} summed over a seat's Claude sessions inside the windows. */
export async function readHostUsage(sessions, windows) {
  const by = {};
  for (const s of sessions) {
    if (!/^[\w-]+$/.test(s)) continue;
    const { stdout } = await run('python3', [PY, 'claude', JSON.stringify(windows), s], { timeout: 120000, maxBuffer: 1 << 22 });
    for (const [m, t] of Object.entries(JSON.parse(stdout).byModel)) { by[m] ??= {}; for (const [k, v] of Object.entries(t)) by[m][k] = (by[m][k] || 0) + v; }
  }
  return by;
}
