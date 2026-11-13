// Back up the factory (decision log + retained artifacts) to a folder, and check a backup restores.
//   node bin/backup.mjs                 → backup into config.backup.root/<date>, then verify it
//   node bin/backup.mjs --verify <dir>  → replay the copy and check every retained file's hash
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from '../core/store.mjs';

/** A consistent copy of the live db (VACUUM INTO is safe while the server writes) plus the artifact files. */
export function backup({ db, root, to }) {
  mkdirSync(to, { recursive: true });
  rmSync(join(to, 'factory.db'), { force: true });
  const src = new DatabaseSync(db);
  try { src.exec(`VACUUM INTO '${join(to, 'factory.db').replaceAll("'", "''")}'`); } finally { src.close(); }
  if (existsSync(root)) cpSync(root, join(to, 'artifacts'), { recursive: true, force: false, errorOnExist: false });
  return to;
}

/** Replays the copied log and re-hashes each retained artifact. */
export function verifyBackup(dir) {
  const store = openStore(join(dir, 'factory.db'));
  const retained = Object.values(store.state.artifacts || {}).filter(a => a.status === 'retained'), problems = [];
  for (const a of retained) {
    const p = join(dir, 'artifacts', a.sha256.slice(0, 2), a.sha256);
    if (!existsSync(p)) { problems.push(`${a.key}: missing`); continue; }
    if (createHash('sha256').update(readFileSync(p)).digest('hex') !== a.sha256) problems.push(`${a.key}: hash mismatch`);
  }
  return { events: store.rows().length, artifacts: retained.length, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
  const v = process.argv.indexOf('--verify');
  const dir = v > 0 ? process.argv[v + 1] : backup({ db: join(ROOT, 'data/factory.db'), root: join(ROOT, 'data/artifacts'),
    to: join((config.backup?.root || '~/Code/factory-backups').replace(/^~/, homedir()), new Date().toISOString().slice(0, 10)) });
  const r = verifyBackup(dir);
  console.log(JSON.stringify({ dir, ...r }));
  process.exit(r.problems.length ? 1 : 0);
}
