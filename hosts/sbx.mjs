// Worker host adapter for Docker sandboxes (sbx). Every host adapter exports the same three calls, so a cloud host
// (an EC2 instance, say) swaps in through config `recycle.host` without the factory changing:
//   health(worker) → {diskPct}          the worker's disk use, 0..1
//   preflight(worker) → [{path, problem, blocking}] work that would die with the host; cycle only with no blocking item
//   recycle(worker, log) → {ok, detail}  replace the host and start a fresh agent in the worker's pane
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { sandboxToken } from '../core/sandbox-seat.mjs';
import { STANDARDS, MIRROR, IN_SANDBOX, CODEX_REVIEW, standardsClaudeMd } from './standards.mjs';
import { QUIT } from '../fleet/factory.mjs';

const run = promisify(execFile);
// The herdr sbx plugin owns the pane ↔ sandbox mapping; its bridge's start mode recreates a missing sandbox from it.
export const PLUGIN = join(homedir(), '.config/herdr/plugins/github/sbx.sandbox-95a2fab8176f');
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
const PREFLIGHT = `cd "$WORKSPACE_DIR" 2>/dev/null || cd /Users/alex.bates/Code/repos/built-rails-a
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

/** `df -P /`, then `--`, then the agent's elapsed seconds (none when no agent runs), as {diskPct, agentSince (epoch ms)}. */
export function parseHealth(out, nowMs = Date.now()) {
  const [df, agent = ''] = String(out).split('\n--\n'), secs = Number(agent.trim());
  return { diskPct: parseDf(df), agentSince: agent.trim() && Number.isFinite(secs) ? nowMs - secs * 1000 : null };
}

/** Disk use, then the elapsed seconds of the sandbox's oldest `agent` process (its interactive session). */
export const healthCmd = (agent = 'claude') => `df -P /; echo --; p=$(pgrep -o -x ${agent}) && ps -o etimes= -p "$p"; true`;

export async function health(worker) {
  const { stdout } = await run('sbx', ['exec', worker.sandbox, 'sh', '-c', healthCmd(worker.agent)], { timeout: 20000 });
  return parseHealth(stdout);
}

export async function preflight(worker) {
  const { stdout } = await run('sbx', ['exec', worker.sandbox, 'bash', '-lc', PREFLIGHT], { timeout: 120000, maxBuffer: 1 << 22 });
  return parsePreflight(stdout);
}

const plugin = f => import(join(PLUGIN, 'src', f));

/** The plugin's own start line for this pane: its HERDR_AGENT env is what lets herdr see the agent's status. */
export async function bridgeLine(worker, stateDir = STATE) {
  const [{ bridgeCommand }, { loadConfig }, { getPaneEntry }, { agentForEntry }] = await Promise.all(['action-main.mjs', 'config.mjs', 'state.mjs', 'lifecycle.mjs'].map(plugin));
  const config = loadConfig(CONFIG), entry = getPaneEntry(stateDir, worker.ref);
  if (!entry) throw new Error(`the sbx plugin has no mapping for pane ${worker.ref}`);
  const agent = agentForEntry(config, entry);
  return bridgeCommand({ pluginEnv: { pluginRoot: PLUGIN, stateDir, configDir: CONFIG, herdrBin: '/opt/homebrew/bin/herdr' }, mode: 'start', paneId: worker.ref, detectionKind: agent.herdrDetectionKind, sbxBin: 'sbx' });
}

/** The sandbox the plugin maps to this pane, or null. */
export async function sandboxOf(paneId, stateDir = STATE) {
  return (await plugin('state.mjs')).getPaneEntry(stateDir, paneId)?.sandboxName || null;
}

/**
 * Move a sandbox's mapping to a new pane, as the plugin's reconnect does for an orphan, so bridgeLine can start it there.
 * Refuses while its old pane is still in herdr or its bridge still runs.
 */
export async function adoptSandbox(sandboxName, paneId, workspaceId, { stateDir = STATE, livePanes }) {
  const [{ loadState, savePaneEntry, deletePaneEntry }, { bridgeIsRunning }] = await Promise.all(['state.mjs', 'lifecycle.mjs'].map(plugin));
  const found = Object.values(loadState(stateDir).panes).filter(e => e.sandboxName === sandboxName);
  if (found.length !== 1) throw new Error(`the sbx plugin maps ${sandboxName} ${found.length} times; expected once`);
  const [entry] = found;
  if (livePanes.includes(entry.paneId)) throw new Error(`pane ${entry.paneId} still holds ${sandboxName}; reconnect it there`);
  if (bridgeIsRunning(entry)) throw new Error(`the bridge for ${sandboxName} is still running`);
  savePaneEntry(stateDir, paneId, { ...entry, workspaceId, sourcePaneId: paneId, adoptedFrom: entry.paneId });
  deletePaneEntry(stateDir, entry.paneId);
}

// Alex's comment hook (every GitHub comment posted as him is 🤖-wrapped). A sandbox's ~/.claude lives in the VM, so
// recreating it (recycle, replace) drops the hook; the factory puts it back. Same matcher as the original sandboxes.
const HOOK_PATH = '/home/agent/.claude/hooks/require-robot-wrapper.sh';
export const ROBOT_HOOK = { matcher: 'Bash|mcp__.*(add_issue_comment|update_issue_comment|add_comment_to_pending_review|pull_request_review_write|create_pull_request_review|add_reply_to_pull_request_comment)',
  hooks: [{ type: 'command', command: `bash ${HOOK_PATH}`, timeout: 10, onFailure: 'block' }] };

// Alex's own switches for things that clutter or park an unattended pane (his ~/.claude/settings.json, 11-05).
export const QUIET = { promptSuggestionEnabled: false, feedbackDrafts: 'off', awaySummaryEnabled: false };

/** The sandbox's settings with the comment hook present once and the quiet switches set; everything else kept. Pure. */
export function withBaseline(settings = {}) {
  const pre = settings.hooks?.PreToolUse || [];
  const hooked = pre.some(h => (h.hooks || []).some(x => x.command === ROBOT_HOOK.hooks[0].command));
  return { ...settings, ...QUIET, hooks: { ...settings.hooks, PreToolUse: hooked ? pre : [...pre, ROBOT_HOOK] } };
}

// "Make auto mode your default permission mode?" shows at agent start until this is set in ~/.claude.json (W-198).
export const withSeenNudge = state => ({ ...state, hasSeenAutoDefaultNudge: true });
const CLAUDE_STATE = '/home/agent/.claude.json';
/** Mark the auto-mode offer seen. Write it while the agent is stopped: a running Claude rewrites this file from memory. */
export async function markNudgeSeen(sandbox) {
  const cur = await run('sbx', ['exec', sandbox, 'cat', CLAUDE_STATE], { timeout: 60000 }).then(r => JSON.parse(r.stdout), () => ({}));
  if (cur.hasSeenAutoDefaultNudge) return;
  await new Promise((resolve, reject) => { const p = execFile('sbx', ['exec', '-i', sandbox, 'sh', '-c', `cat > ${CLAUDE_STATE}`], { timeout: 60000 }, e => e ? reject(e) : resolve()); p.stdin.end(JSON.stringify(withSeenNudge(cur), null, 2)); });
}

// Codex has no hook, so Alex's comment rule is an instruction in its AGENTS.md (wording from require-robot-wrapper.sh).
export const ROBOT_RULE = "## GitHub comments\n\nAlex's rule: text posted to GitHub as him must have a line '🤖' alone at the start and a line '🤖' alone at the end. "
  + 'That covers every PR or issue comment, review comment, reply and review body (gh pr comment, gh pr review, gh issue comment, gh api comments/replies/reviews, GraphQL comment mutations). '
  + 'Write the body to a file and pass it with --body-file or -F body=@file, wrapped in those two lines.\n';
export const codexAgentsMd = (dir = MIRROR) => `${standardsClaudeMd(dir)}\n${ROBOT_RULE}`;

/** Benny's documents in a sandbox: the files, and the agent's user instructions file so every worker session loads them (Alex, 11-09). */
export async function installStandards(sandbox, put = sbxPut(sandbox), agent = 'claude') {
  for (const name of STANDARDS) await put(`${IN_SANDBOX}/${name}`, readFileSync(join(MIRROR, name), 'utf8'));
  if (agent !== 'codex') return put('/home/agent/.claude/CLAUDE.md', standardsClaudeMd());
  await put(`${IN_SANDBOX}/${CODEX_REVIEW}`, readFileSync(join(MIRROR, CODEX_REVIEW), 'utf8'));
  await put('/home/agent/.codex/AGENTS.md', codexAgentsMd());
}
const sbxPut = sandbox => (path, text) => new Promise((resolve, reject) => {
  const p = execFile('sbx', ['exec', '-i', sandbox, 'sh', '-c', `mkdir -p "$(dirname ${path})" && cat > ${path}`], { timeout: 60000 }, e => e ? reject(e) : resolve());
  p.stdin.end(text);
});

const sbxRead = sandbox => path => run('sbx', ['exec', sandbox, 'cat', path], { timeout: 60000 }).then(r => r.stdout, () => '');

/**
 * A sandbox's baseline for its agent. Claude: the comment hook and its settings entry, standards, board MCP, nudge seen.
 * Codex: standards and the 🤖 rule in AGENTS.md, the review prompt, and the board server in its config.toml.
 */
export async function restoreBaseline(sandbox, agent = 'claude', { put = sbxPut(sandbox), read = sbxRead(sandbox), secret, secrets = gemSecrets, bundle = bundleGems, mcpLoad = loadMcp } = {}) {
  if (agent === 'codex') {
    await installStandards(sandbox, put, agent);
    await put(CODEX_CONFIG, withBoardMcpToml(noUpdateCheck(await read(CODEX_CONFIG)), boardMcp(sandbox, { secret })));
    await secrets(sandbox);
    await bundle(sandbox);
    await mcpLoad('sentry', sandbox);
    return;
  }
  await put(HOOK_PATH, readFileSync(join(homedir(), '.claude/hooks/require-robot-wrapper.sh'), 'utf8'));
  const cur = await run('sbx', ['exec', sandbox, 'cat', '/home/agent/.claude/settings.json'], { timeout: 60000 }).then(r => JSON.parse(r.stdout), () => ({}));
  await put('/home/agent/.claude/settings.json', JSON.stringify(withBaseline(cur), null, 2) + '\n');
  await installStandards(sandbox, put);
  await installBoardMcp(sandbox);
  await markNudgeSeen(sandbox);
  await secrets(sandbox);
  await bundle(sandbox);
}

// built-rails' own script: GraphQL Pro and Sidekiq Pro credentials from the host's bundler config into the sandbox.
const BUILT_RAILS = join(homedir(), 'Code/repos/built-rails-a');
// Codex has no claude.ai connectors: Sentry comes through the sandbox's gateway (registered once with `sbx mcp add`, W-306).
const loadMcp = (name, sandbox) => run('sbx', ['mcp', 'load', name, '--sandbox', sandbox], { timeout: 60000 });
// A worker that can't boot the suite can't prove a fix red-first (W-327): install whatever gems the checkout lacks.
const bundleGems = sandbox => run('sbx', ['exec', sandbox, 'bash', '-lc', `cd '${BUILT_RAILS}' && (bundle check >/dev/null || bundle install --quiet)`], { timeout: 900000 });
const gemSecrets = sandbox => run(join(BUILT_RAILS, 'bin/sbx-secrets'), [sandbox], { cwd: BUILT_RAILS, timeout: 120000 });

/** The worker's way onto the board: the factory's sandbox port, with this sandbox's name and token (sbx-workers-on-the-board). */
export function boardMcp(sandbox, { port = 4849, secret = readFileSync(new URL('../data/sandbox-secret', import.meta.url), 'utf8').trim() } = {}) {
  return { url: `http://host.docker.internal:${port}/mcp`, headers: { 'x-sandbox': sandbox, 'x-sandbox-token': sandboxToken(secret, sandbox) } };
}

const CODEX_CONFIG = '/home/agent/.codex/config.toml';
const BOARD_TABLE = /^\[mcp_servers\.(software-factory|"software-factory")(\.[^\]]*)?\]\s*$/;
// The version is pinned; Codex's "Update available" dialog would park the worker at every start.
const noUpdateCheck = (toml = '') => `check_for_update_on_startup = false\n${String(toml).split('\n').filter(l => !/^check_for_update_on_startup\s*=/.test(l)).join('\n')}`;
/** Codex's config.toml with the software-factory server (and its subtables) replaced by one block; the rest kept. Pure. */
export function withBoardMcpToml(toml = '', { url, headers }) {
  let mine = false;
  const kept = String(toml).split('\n').filter(l => { if (/^\s*\[/.test(l)) mine = BOARD_TABLE.test(l.trim()); return !mine; }).join('\n').trimEnd();
  const q = JSON.stringify; // a JSON string is a valid TOML basic string for these values
  const block = `[mcp_servers.software-factory]\nurl = ${q(url)}\nhttp_headers = { ${Object.entries(headers).map(([k, v]) => `${q(k)} = ${q(v)}`).join(', ')} }\n`;
  return kept ? `${kept}\n\n${block}` : block;
}

export async function installBoardMcp(sandbox, { port = 4849 } = {}) {
  const { url, headers } = boardMcp(sandbox, { port });
  const add = ['claude', 'mcp', 'add', '-s', 'user', '--transport', 'http', 'software-factory', url, ...Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`])];
  const sh = a => a.map(x => `'${x.replace(/'/g, `'\\''`)}'`).join(' ');
  await run('sbx', ['exec', sandbox, 'bash', '-lc', `claude mcp remove -s user software-factory >/dev/null 2>&1; ${sh(add)}`], { timeout: 60000 });
}

const herdr = (...a) => run('herdr', a, { timeout: 30000 });
const atShell = async worker => !(await herdr('pane', 'process-info', '--pane', worker.ref)).stdout.includes('bridge.mjs');
/** The key that moves a quit along: Exit in Claude's "Background work is running" dialog, Enter when the quit command sits unsent in the input box (W-326), else null. */
export function exitChoice(screen, quit) {
  const m = /Background work is running[\s\S]*?(\d)\.\s*Exit and stop tasks/.exec(String(screen));
  if (m) return m[1];
  return quit && String(screen).split('\n').some(l => /^\s*[›❯>]\s*(\S.*)$/.exec(l)?.[1].trim() === quit) ? 'enter' : null;
}

/** Quit the worker's agent and wait for its pane's shell; false when it didn't exit within a minute. */
async function exitAgent(worker) {
  const quit = QUIT[worker.agent] || QUIT.claude;
  // Codex drops an Enter that lands in the same burst as the text, so let the text settle first.
  await herdr('pane', 'send-text', worker.ref, quit); await pause(500); await herdr('pane', 'send-keys', worker.ref, 'enter');
  for (let i = 0; i < 20 && !(await atShell(worker)); i++) {
    await pause(3000);
    // Callers exit only between jobs, so the tasks it stops are a finished job's leftovers (Alex, TB-158 a).
    const key = exitChoice((await herdr('pane', 'read', worker.ref, '--source', 'visible').catch(() => ({ stdout: '' }))).stdout, quit);
    if (key) await herdr('pane', 'send-keys', worker.ref, key);
  }
  return atShell(worker);
}

/** A fresh agent session in the same sandbox: its disk, repo and installed board MCP stay; its context doesn't. */
export async function restart(worker) {
  const line = await bridgeLine(worker);
  if (!(await atShell(worker)) && !(await exitAgent(worker))) return { ok: false, detail: 'the agent did not exit' };
  if (worker.agent !== 'codex') await markNudgeSeen(worker.sandbox).catch(() => {}); // the unblocker rule still covers the dialog if this fails
  await herdr('pane', 'run', worker.ref, line);
  for (let i = 0; i < 20; i++) { await pause(3000); if (!(await atShell(worker))) return { ok: true, detail: `fresh session in ${worker.sandbox}` }; }
  return { ok: false, detail: `no agent running in ${worker.sandbox} a minute after the restart` };
}

/** Exit the agent, remove the sandbox, then the plugin's bridge recreates it (same name, template and kit) in the same pane. */
export async function recycle(worker, log = () => {}) {
  const line = await bridgeLine(worker);
  if (!(await exitAgent(worker))) return { ok: false, detail: 'the agent did not exit; nothing removed' };
  log(`recycle ${worker.label}: agent exited; removing ${worker.sandbox}`);
  await run('sbx', ['rm', '--force', worker.sandbox], { timeout: 300000 });
  await herdr('pane', 'run', worker.ref, line);
  log(`recycle ${worker.label}: recreating ${worker.sandbox}`);
  // Creating from the template and running its setup takes minutes.
  for (let i = 0; i < 120; i++) {
    await pause(10000);
    const { stdout } = await run('sbx', ['ls'], { timeout: 20000 }).catch(() => ({ stdout: '' }));
    if (new RegExp(`^${worker.sandbox}\\s+\\S+\\s+running`, 'm').test(stdout) && !(await atShell(worker))) {
      // The fresh VM has no ~/.claude of Alex's; the running session picks the hook up from its settings file.
      const hook = await restoreBaseline(worker.sandbox, worker.agent).then(() => 'baseline restored', e => `baseline NOT restored: ${e.message}`);
      // A fresh VM has no Codex login, and Codex reads its config only at start.
      if (worker.agent === 'codex') return { ok: true, detail: `${worker.sandbox} recreated; ${hook}. Codex needs Alex: bin/sbx-codex-login ${worker.sandbox} from built-rails-a, then a restart to load its board tools` };
      return { ok: true, detail: `${worker.sandbox} recreated and its agent started; ${hook}` };
    }
  }
  return { ok: false, detail: `${worker.sandbox} not running with an agent after 20 minutes` };
}
