// The review benchmark (evolution phase 1 step 5).
//   node bin/bench.mjs report [since]  → reviews, retained evidence, manifests and unadjudicated escapes since a time
//   node bin/bench.mjs corpus   → data/bench/corpus-<date>.json (git-ignored: the repo is public) from the live board, each case's base pinned from GitHub
//   node bin/bench.mjs run [--after <iso>] [--repeats 3] [--agents claude,codex] [--cases id,..] [--limit n] [--corpus file]
//        → each eval case reviewed headless in its stream's sandbox, in a scratch worktree at the case's head; results and
//          score.md in data/bench/runs-<date>/. Re-running skips finished runs. Writes nothing to the board or GitHub.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from '../core/store.mjs';
import { benchPlan, corpusCandidates, qualityReport, reviewPrompt, scoreSheet, selectCorpus } from '../core/bench.mjs';
import { streamBusy } from '../core/recycle.mjs';
import { sandboxOf } from '../hosts/sbx.mjs';

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

if (process.argv[2] === 'report') console.log(JSON.stringify(qualityReport(openStore(process.env.FACTORY_DB || join(ROOT, 'data/factory.db')).state, process.argv[3] || new Date(Date.now() - 7 * 864e5).toISOString()), null, 2));

// One run inside the sandbox: a detached worktree at the head (another repo is cloned once under /tmp/bench/repos), the
// reviewer headless, outputs outside the worktree, then the worktree removed. Prints the outputs base64 after markers.
const RUN = readFileSync(join(ROOT, 'bin/bench-run.sh'), 'utf8');

const field = (text, mark) => text.split('\n').find(l => l.startsWith(`@@${mark} `))?.slice(mark.length + 3);
const block = (text, mark) => { const ls = text.split('\n'), i = ls.indexOf(`@@${mark}`); return i < 0 ? '' : Buffer.from(ls[i + 1] || '', 'base64').toString('utf8'); };

/** The review text and a usage line from either agent's raw output. */
function outcome(agent, md, raw) {
  if (agent === 'codex') {
    const done = raw.split('\n').filter(l => l.includes('"turn.completed"')).map(l => { try { return JSON.parse(l).usage; } catch { return null; } }).filter(Boolean);
    const sum = k => done.reduce((n, u) => n + (u[k] || 0), 0);
    return { output: md.trim(), usage: done.length ? `${Math.round(sum('input_tokens') / 1000)}k in (${Math.round(sum('cached_input_tokens') / 1000)}k cached), ${Math.round(sum('output_tokens') / 1000)}k out` : null };
  }
  try { const j = JSON.parse(raw); return { output: String(j.result || '').trim(), usage: `$${(j.total_cost_usd || 0).toFixed(2)}, ${j.num_turns} turns` }; }
  catch { return { output: raw.trim().slice(-4000), usage: null }; }
}

const sh = (cmd, args, ms) => new Promise(res => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); let out = '', err = '';
  const t = setTimeout(() => p.kill('SIGKILL'), ms);
  p.stdout.on('data', d => out += d); p.stderr.on('data', d => err += d);
  p.on('close', code => { clearTimeout(t); res({ code, out, err }); });
});
const pause = ms => new Promise(r => setTimeout(r, ms));
const arg = (name, dflt) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : dflt; };

if (process.argv[2] === 'run') {
  const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
  const corpusFile = arg('corpus', join(ROOT, 'data/bench', readdirSync(join(ROOT, 'data/bench')).filter(f => /^corpus-.*\.json$/.test(f)).sort().at(-1)));
  const corpus = JSON.parse(readFileSync(corpusFile, 'utf8')), only = arg('cases', '').split(',').filter(Boolean);
  if (only.length) corpus.cases = corpus.cases.filter(c => only.includes(c.id));
  const after = arg('after'), capS = Number(arg('cap-min', 45)) * 60, limit = Number(arg('limit', Infinity));
  const outDir = join(ROOT, 'data/bench', `runs-${(after || new Date().toISOString()).slice(0, 10)}`);
  mkdirSync(outDir, { recursive: true });
  const log = m => console.log(`${new Date().toISOString()} ${m}`);
  if (after && Date.parse(after) > Date.now()) { log(`waiting until ${after}`); while (Date.parse(after) > Date.now()) await pause(30000); }
  const panes = (await herdrJson('pane', 'list')).result.panes;
  const streams = Object.entries(config.routing.supervisors).filter(([, s]) => s.worker).map(([sup, s]) => ({ sup, worker: s.worker, agent: s.agent || 'claude' }));
  const agents = arg('agents', 'claude,codex').split(',');
  const sheet = () => writeFileSync(join(outDir, 'score.md'), scoreSheet(corpus, readdirSync(outDir).filter(f => f.endsWith('.json')).map(f => JSON.parse(readFileSync(join(outDir, f), 'utf8')))));
  const busy = async sup => { try { return streamBusy((await (await fetch('http://127.0.0.1:4848/api/state')).json()).work, sup); } catch { return false; } };
  const goals = await fetch('http://127.0.0.1:4848/api/state').then(r => r.json()).then(s => s.work).catch(() => ({}));
  await Promise.all(agents.map(async agent => {
    const st = streams.find(s => s.agent === agent), pane = st && panes.find(p => p.label === st.worker)?.pane_id, sandbox = pane && await sandboxOf(pane);
    if (!sandbox) return log(`${agent}: no stream sandbox found; skipped`);
    const jobs = benchPlan(corpus, { repeats: Number(arg('repeats', 3)), agents: [agent] }).slice(0, limit);
    for (const j of jobs) {
      const file = join(outDir, `${j.dir}.json`);
      if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).status === 'ok') continue;
      while (await busy(st.sup)) { log(`${j.dir}: ${st.sup} has a job running; waiting`); await pause(300000); }
      log(`${j.dir}: starting in ${sandbox}`);
      const t0 = Date.now(), prompt = reviewPrompt(j.case, agent, { goal: goals[j.case.work]?.objective || '' });
      const r = await sh('sbx', ['exec', sandbox, 'bash', '-lc', RUN, 'bench', j.case.repo, j.case.head, j.case.base, j.dir, agent, String(capS), Buffer.from(prompt).toString('base64')], (capS + 600) * 1000);
      const rc = Number(field(r.out, 'RC') ?? -1), dirty = Number(field(r.out, 'DIRTY') || 0);
      const status = rc === 0 ? (dirty ? 'ok, worktree left dirty' : 'ok') : rc === 124 ? 'timeout' : rc === 98 ? 'no worktree' : `failed (${rc}${r.code ? `, exec ${r.code}` : ''}): ${r.err.trim().split('\n').at(-1) || ''}`;
      const res = { case: j.case.id, agent, n: j.n, stream: st.sup, sandbox, status: status.startsWith('ok') && !dirty ? 'ok' : status, startedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0,
        busyDuring: await busy(st.sup), ...outcome(agent, block(r.out, 'MD'), block(r.out, 'RAW')) };
      writeFileSync(file, `${JSON.stringify(res, null, 2)}\n`); sheet();
      log(`${j.dir}: ${res.status} in ${Math.round(res.durationMs / 60000)}m${res.usage ? `, ${res.usage}` : ''}`);
    }
  }));
  sheet(); log(`done: ${join(outDir, 'score.md')}`);
}

async function herdrJson(...args) { const r = await sh('herdr', args, 30000); return JSON.parse(r.out); }
