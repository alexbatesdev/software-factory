import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRecycles } from '../core/recycle.mjs';
import { autoDispatchPlan } from '../core/dispatch.mjs';

const S = 'sup: s', unit = status => ({ id: 'u', supervisor: { label: S, status: 'idle' }, worker: { label: 'sbx: s', status, sandbox: 'box-1' } });
const busy = { 'W-1': { id: 'W-1', stream: S, assignments: [{ id: 'R1', kind: 'implementation', status: 'started' }] } };
const free = { 'W-1': { id: 'W-1', stream: S, assignments: [{ id: 'R1', kind: 'implementation', status: 'done' }, { id: 'R2', kind: 'fixes', status: 'queued' }] } };

test('a worker over the threshold drains its stream, and cycles only between tasks', () => {
  assert.deepEqual(planRecycles({ units: [unit('idle')], health: { u: { diskPct: 0.7 } }, works: free, supervisors: [S] }).drain.size, 0, 'under 75% nothing happens');
  const mid = planRecycles({ units: [unit('working')], health: { u: { diskPct: 0.95 } }, works: busy, supervisors: [S] });
  assert.match(mid.drain.get(S), /95%/);
  assert.deepEqual(mid.due, [], 'a running job finishes first');
  assert.deepEqual(planRecycles({ units: [unit('idle')], health: { u: { diskPct: 0.95 } }, works: free, supervisors: [S] }).due.map(d => d.unit), ['u'], 'queued work waits for the cycle');
});

test('a cycle under way, or one that failed, keeps the stream drained', () => {
  const p = planRecycles({ units: [unit('idle')], health: {}, works: free, recycling: { u: { step: 'removing', failed: 'sbx rm exited 1' } }, supervisors: [S] });
  assert.match(p.drain.get(S), /recycle failed: sbx rm exited 1/);
  assert.deepEqual(p.due, []);
});

test('auto-dispatch sends nothing to a draining stream', () => {
  const cfg = { supervisors: { [S]: { worker: 'sbx: s' }, 'sup: t': { worker: 'sbx: t' } }, exclude: [] };
  const w = { id: 'W-9', title: 'x', phase: 'ready', priority: 3, owner: S, stream: S, streamPin: { by: 't' }, openQuestions: 0, openDeps: [], externalDeps: [], requests: [], assignments: [], links: {} };
  const [p] = autoDispatchPlan([w], { ...cfg, drain: new Map([[S, 'sbx: s disk at 95%']]) });
  assert.equal(p.action, null);
  assert.match(p.reason, /disk at 95%/);
});

test('the sbx adapter reads disk use and finds work that would die with the sandbox', async () => {
  const { parseDf, parsePreflight } = await import('../hosts/sbx.mjs');
  assert.equal(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 20511312 18320000 1100000 95% /'), 0.95);
  const p = parsePreflight('/a\t0\tok\t1\n/b\t3\tok\t1\n/c\t0\tunpushed\t1\n/d\t0\tunpushed\t9\n/e\t0\treplaced\t6\n/f\t0\treplaced\t0\n');
  assert.deepEqual(p.map(x => [x.path, x.blocking]), [['/b', true], ['/c', true], ['/d', false], ['/e', false], ['/f', true]]);
});

test('only configured streams are ever drained or recycled (Mutation is Alex own)', () => {
  const mut = { id: 'm', supervisor: { label: 'sup: mutation-tester', status: 'idle' }, worker: { label: 'sbx: mutation-tester', status: 'idle', sandbox: 'box-m' } };
  const p = planRecycles({ units: [mut], health: { m: { diskPct: 0.99 } }, works: {}, supervisors: [S] });
  assert.deepEqual([p.drain.size, p.due.length], [0, 0]);
});

// A plugin state dir holding one mapping, as the sbx plugin writes it.
async function pluginState(paneId, sandboxName) {
  const { mkdtempSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
  const { PLUGIN } = await import('../hosts/sbx.mjs');
  const { savePaneEntry } = await import(join(PLUGIN, 'src', 'state.mjs'));
  const dir = mkdtempSync(join(tmpdir(), 'sf-sbx-'));
  savePaneEntry(dir, paneId, { sandboxName, workspaceId: paneId.split(':')[0], agentKind: 'claude-code', sbxAgent: 'claude', localPath: '/x', workdir: '/x', workspaceMode: 'clone', lifecycleState: 'ready', bridgePid: null });
  return dir;
}

test("a recycled sandbox's agent starts the way the sbx plugin starts it, so herdr can see whether it is working", async () => {
  const { bridgeLine } = await import('../hosts/sbx.mjs');
  const line = await bridgeLine({ ref: 'w9:p3' }, await pluginState('w9:p3', 'box-1'));
  assert.match(line, /HERDR_AGENT='?claude'?\s/);
  assert.match(line, /bridge\.mjs'? '?start'? /);
});

test('a sandbox whose pane is gone (herdr restarted) moves to a new pane, and only when its old pane really is gone', async () => {
  const { adoptSandbox, bridgeLine, sandboxOf } = await import('../hosts/sbx.mjs');
  const dir = await pluginState('w9:p3', 'box-1');
  await assert.rejects(adoptSandbox('box-1', 'w2:p1', 'w2', { stateDir: dir, livePanes: ['w9:p3'] }), /still holds box-1/);
  await adoptSandbox('box-1', 'w2:p1', 'w2', { stateDir: dir, livePanes: [] });
  assert.equal(await sandboxOf('w2:p1', dir), 'box-1');
  assert.equal(await sandboxOf('w9:p3', dir), null);
  assert.match(await bridgeLine({ ref: 'w2:p1' }, dir), /--pane-id'? '?w2:p1/);
});

test("a recreated sandbox gets back Alex's comment hook without losing its other settings or doubling the hook", async () => {
  const { withBaseline, ROBOT_HOOK } = await import('../hosts/sbx.mjs');
  const bare = { themeId: 1, permissions: { defaultMode: 'bypassPermissions' } };
  const once = withBaseline(bare);
  assert.equal(once.themeId, 1);
  assert.deepEqual([once.promptSuggestionEnabled, once.feedbackDrafts, once.awaySummaryEnabled], [false, 'off', false]);
  assert.equal(once.hooks.PreToolUse.filter(h => h.hooks.some(x => x.command === ROBOT_HOOK.hooks[0].command)).length, 1);
  assert.deepEqual(withBaseline(once), once, 'applying it twice changes nothing');
});

test('a worker whose session finished a job restarts fresh at the boundary, after a quiet spell, and only when switched on', () => {
  const t = Date.parse('2026-11-06T18:00:00Z'), iso = ms => new Date(ms).toISOString();
  const works = { 'W-1': { id: 'W-1', stream: S, updates: [{ at: iso(t - 600000), by: 'sbx: s' }], assignments: [{ id: 'R1', kind: 'implementation', status: 'done', history: [{ status: 'done', at: iso(t - 600000) }] }] } };
  const base = { units: [unit('idle')], health: {}, works, supervisors: [S], now: t, restartStale: true };
  assert.deepEqual(planRecycles({ ...base, sessions: { u: t - 3600000 } }).due.map(d => [d.unit, d.restart]), [['u', true]]);
  assert.deepEqual(planRecycles({ ...base, sessions: { u: t - 300000 } }).due, [], 'a session started after the last job is fresh');
  const parkedJob = { 'W-2': { id: 'W-2', stream: S, assignments: [{ id: 'R1', kind: 'implementation', status: 'blocked', waitingOn: 'TB-9' }] } };
  assert.equal(planRecycles({ ...base, works: { ...works, ...parkedJob }, sessions: { u: t - 3600000 } }).due.length, 1, 'a parked job does not hold the worker');
  assert.deepEqual(planRecycles({ ...base, restartStale: false, sessions: { u: t - 3600000 } }).due, [], 'off by default');
  assert.deepEqual(planRecycles({ ...base, units: [unit('working')], sessions: { u: t - 3600000 } }).due, [], 'never while the worker is working');
  const fresh = { 'W-1': { ...works['W-1'], updates: [{ at: iso(t - 60000), by: S }] } };
  assert.deepEqual(planRecycles({ ...base, works: fresh, sessions: { u: t - 3600000 } }).due, [], 'not while the supervisor may be briefing');
});

test("a worker's health reading carries its disk use and when its agent session started", async () => {
  const { parseHealth } = await import('../hosts/sbx.mjs');
  const out = 'Filesystem 1024-blocks Used Available Capacity Mounted on\noverlay 20466256 7206360 12194936 38% /\n--\n  85676\n';
  assert.deepEqual(parseHealth(out, 100000000), { diskPct: 0.38, agentSince: 100000000 - 85676000 });
  assert.deepEqual(parseHealth(out.replace('  85676\n', ''), 1), { diskPct: 0.38, agentSince: null }, 'no agent running');
});
