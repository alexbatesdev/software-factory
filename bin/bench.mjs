// The review benchmark (evolution phase 1 step 5).
//   node bin/bench.mjs corpus   → data/bench/corpus-<date>.json (git-ignored: the repo is public) from the live board, each case's base pinned from GitHub
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../core/store.mjs';
import { corpusCandidates, selectCorpus } from '../core/bench.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = promisify(execFile);

// The parent of the PR's first commit: the main it branched from (gh read only).
async function baseOf(repo, pr) {
  const { stdout } = await run('gh', ['api', `repos/${repo}/pulls/${pr.split('/').pop()}/commits?per_page=1`, '-q', '.[0].parents[0].sha'], { timeout: 30000 });
  return stdout.trim() || null;
}

if (process.argv[2] === 'corpus') {
  const store = openStore(process.env.FACTORY_DB || join(ROOT, 'data/factory.db'));
  const cases = selectCorpus(corpusCandidates(store.state));
  for (const c of cases) c.base = await baseOf(c.repo, c.pr).catch(e => { console.error(`${c.id}: base unread (${e.message.split('\n')[0]})`); return null; });
  mkdirSync(join(ROOT, 'data/bench'), { recursive: true });
  const out = join(ROOT, 'data/bench', `corpus-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(out, `${JSON.stringify({ builtAt: new Date().toISOString(), fromSeq: store.state.seq, cases }, null, 2)}\n`);
  console.log(`${out}: ${cases.length} cases (${cases.filter(c => c.split === 'eval').length} eval, ${cases.filter(c => c.split === 'tune').length} tune)`);
}
