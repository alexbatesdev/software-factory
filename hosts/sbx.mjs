// Worker host adapter for Docker sandboxes (sbx). Every host adapter exports the same three calls, so a cloud host
// (an EC2 instance, say) swaps in through config `recycle.host` without the factory changing:
//   health(worker) → {diskPct}          the worker's disk use, 0..1
//   preflight(worker) → [{path, problem, blocking}] work that would die with the host; cycle only with no blocking item
//   recycle(worker, log) → {ok, detail}  replace the host and start a fresh agent in the worker's pane
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
// The herdr sbx plugin owns the pane ↔ sandbox mapping; its bridge's start mode recreates a missing sandbox from it.
const PLUGIN = join(homedir(), '.config/herdr/plugins/github/sbx.sandbox-95a2fab8176f');
const STATE = join(homedir(), '.local/state/herdr/plugins/sbx.sandbox'), CONFIG = join(homedir(), '.config/herdr/plugins/config/sbx.sandbox');
const pause = ms => new Promise(r => setTimeout(r, ms));

/** Use% of the root filesystem from `df -P /`, as 0..1. */
export const parseDf = out => { const m = String(out).trim().split('\n').at(-1)?.match(/\s(\d+)%\s/); return m ? Number(m[1]) / 100 : null; };

/**
 * Each worktree's risk. Blocking: tracked uncommitted changes, or commits under STALE_DAYS old that GitHub doesn't have
 * or has moved past. Older ones are reported but don't block: a restack replaced them, or the work was abandoned.
 */
const STALE_DAYS = 3;
export function parsePreflight(out) {
  return String(out).split('\n').filter(Boolean).map(l => l.split('\t')).flatMap(([path, dirty, state, age]) => [
    ...(Number(dirty) > 0 ? [{ path, problem: `${dirty} uncommitted change(s)`, blocking: true }] : []),
    ...(state === 'unpushed' ? [{ path, problem: `commits GitHub doesn't have (${age} day(s) old)`, blocking: Number(age) < STALE_DAYS }] : []),
    ...(state === 'replaced' ? [{ path, problem: `replaced on GitHub by a newer push (${age} day(s) old)`, blocking: Number(age) < STALE_DAYS }] : []),
  ]);
}

// Workers push by HTTPS URL (SSH is blocked in the VM), which never updates origin/* refs, so "pushed" is asked of GitHub:
// HEAD is a branch tip there, inside its branch, or inside main (merged, branch deleted). Build output and spamton-* don't count.
// Prints `<path>\t<dirty>\t<ok|replaced|unpushed>\t<days since HEAD's commit>` per worktree.
const PREFLIGHT = `cd "$WORKSPACE_DIR" 2>/dev/null || cd /Users/alex.bates/Code/built-rails-a
url=$(git remote get-url origin | sed -E 's#^git@github.com:#https://github.com/#')
heads=$(git ls-remote --heads "$url" 2>/dev/null)
git fetch -q "$url" main:refs/factory/main </dev/null 2>/dev/null
git worktree list --porcelain | sed -n 's/^worktree //p' | while read -r d; do
  dirty=$(git -C "$d" status --porcelain 2>/dev/null | grep -vE ' public/javascripts/| spamton-' | wc -l | tr -d ' ')
  head=$(git -C "$d" rev-parse HEAD); branch=$(git -C "$d" symbolic-ref --short -q HEAD)
  age=$(( ( $(date +%s) - $(git -C "$d" log -1 --format=%ct) ) / 86400 ))
  if printf '%s\\n' "$heads" | cut -f1 | grep -qx "$head" || git -C "$d" merge-base --is-ancestor "$head" refs/factory/main 2>/dev/null; then state=ok
  elif [ -n "$branch" ] && printf '%s\\n' "$heads" | grep -q "refs/heads/$branch$"; then
    if git -C "$d" fetch -q "$url" "$branch" </dev/null 2>/dev/null && git -C "$d" merge-base --is-ancestor "$head" FETCH_HEAD; then state=ok; else state=replaced; fi
  else state=unpushed; fi
  printf '%s\\t%s\\t%s\\t%s\\n' "$d" "$dirty" "$state" "$age"
done`;

export async function health(worker) {
  const { stdout } = await run('sbx', ['exec', worker.sandbox, 'df', '-P', '/'], { timeout: 20000 });
  return { diskPct: parseDf(stdout) };
}

export async function preflight(worker) {
  const { stdout } = await run('sbx', ['exec', worker.sandbox, 'bash', '-lc', PREFLIGHT], { timeout: 120000, maxBuffer: 1 << 22 });
  return parsePreflight(stdout);
}

/** The plugin's own start line for this pane: its HERDR_AGENT env is what lets herdr see the agent's status. */
export async function bridgeLine(worker) {
  const src = f => import(join(PLUGIN, 'src', f));
  const [{ bridgeCommand }, { loadConfig }, { getPaneEntry }, { agentForEntry }] = await Promise.all(['action-main.mjs', 'config.mjs', 'state.mjs', 'lifecycle.mjs'].map(src));
  const config = loadConfig(CONFIG), entry = getPaneEntry(STATE, worker.ref);
  if (!entry) throw new Error(`the sbx plugin has no mapping for pane ${worker.ref}`);
  const agent = agentForEntry(config, entry);
  return bridgeCommand({ pluginEnv: { pluginRoot: PLUGIN, stateDir: STATE, configDir: CONFIG, herdrBin: '/opt/homebrew/bin/herdr' }, mode: 'start', paneId: worker.ref, detectionKind: agent.herdrDetectionKind, sbxBin: 'sbx' });
}

/** Exit the agent, remove the sandbox, then the plugin's bridge recreates it (same name, template and kit) in the same pane. */
export async function recycle(worker, log = () => {}) {
  const herdr = (...a) => run('herdr', a, { timeout: 30000 });
  const atShell = async () => !(await herdr('pane', 'process-info', '--pane', worker.ref)).stdout.includes('bridge.mjs');
  await herdr('pane', 'send-text', worker.ref, '/exit'); await herdr('pane', 'send-keys', worker.ref, 'enter');
  for (let i = 0; i < 20 && !(await atShell()); i++) await pause(3000);
  if (!(await atShell())) return { ok: false, detail: 'the agent did not exit; nothing removed' };
  log(`recycle ${worker.label}: agent exited; removing ${worker.sandbox}`);
  await run('sbx', ['rm', '--force', worker.sandbox], { timeout: 300000 });
  await herdr('pane', 'run', worker.ref, await bridgeLine(worker));
  log(`recycle ${worker.label}: recreating ${worker.sandbox}`);
  // Creating from the template and running its setup takes minutes.
  for (let i = 0; i < 120; i++) {
    await pause(10000);
    const { stdout } = await run('sbx', ['ls'], { timeout: 20000 }).catch(() => ({ stdout: '' }));
    if (new RegExp(`^${worker.sandbox}\\s+\\S+\\s+running`, 'm').test(stdout) && !(await atShell())) return { ok: true, detail: `${worker.sandbox} recreated and its agent started` };
  }
  return { ok: false, detail: `${worker.sandbox} not running with an agent after 20 minutes` };
}
