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

/** The sandbox user's ~/.claude/CLAUDE.md: both documents inlined (an @-import can park a session at an approval dialog). */
export function standardsClaudeMd(dir = MIRROR) {
  return `# Team standards\n\nWritten by the software factory from Benny's documents; it is replaced at every sandbox restore, so don't edit it here. The Definition of Done is the bar for finishing any task: close with its exit report. Before asking your supervisor a question, check "What Would Benny Do?": if a passage settles it, act and name the passage.\n\n`
    + STANDARDS.map(name => readFileSync(join(dir, name), 'utf8').trim()).join('\n\n---\n\n') + '\n';
}
