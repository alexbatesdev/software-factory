// Benny's Definition of Done and "What Would Benny Do?" (Alex, 11-09): the source stays in ~/Documents; the factory
// mirrors it where host seats read it, and restoreBaseline copies the mirror into each sandbox.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const STANDARDS = ['DEFINITION_OF_DONE.md', 'WWBD.md'];
export const SOURCE = join(homedir(), 'Documents'), MIRROR = join(homedir(), 'Code/plans/standards'), IN_SANDBOX = '/home/agent/standards';

/** Copy each document whose text differs; returns the names it wrote. */
export function syncStandards(src = SOURCE, dst = MIRROR) {
  mkdirSync(dst, { recursive: true });
  return STANDARDS.filter(name => {
    const text = readFileSync(join(src, name), 'utf8'), to = join(dst, name);
    if (existsSync(to) && readFileSync(to, 'utf8') === text) return false;
    writeFileSync(to, text);
    return true;
  });
}
