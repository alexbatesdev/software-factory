import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { commandsFor } from '../core/actions.mjs';
import { autoDispatchPlan } from '../core/dispatch.mjs';
import { claudeTuned, codexTuned } from '../hosts/sbx.mjs';

// Alex, 11-11 ("go deep-model"): a record can ask for a model and an effort, set separately; the worker restarts with them.
const ctx = { now: '2026-11-11T18:00:00.000Z', by: 'board lead' };
const S1 = 'sup: stream-1', S2 = 'sup: stream-2', HOST = 'sup: host';
const cfg = { supervisors: { [S1]: { worker: 'sbx: stream-1' }, [S2]: { worker: 'sbx: stream-2', agent: 'codex' }, [HOST]: { repos: { 'teamwork-mini-mcp': '~' } } } };
const w = (id, over = {}) => ({ id, title: 'x', phase: 'ready', priority: 3, owner: null, stream: null, streamPin: null, openQuestions: 0, openDeps: [], externalDeps: [], requests: [], assignments: [], links: {}, ...over });
const plan = (works, running = {}) => Object.fromEntries(autoDispatchPlan(works, { ...cfg, running }).map(p => [p.id, p]));

test('triage and create set model and effort separately; an unknown value is refused, and "default" clears it', () => {
  const store = openStore(':memory:');
  const run = (action, args) => { for (const c of commandsFor(action, { ...args, by: ctx.by })) store.append(c, ctx); };
  run('create', { title: 'Subtle race', model: 'opus', effort: 'xhigh' });
  assert.deepEqual([store.state.work['W-1'].model, store.state.work['W-1'].effort], ['opus', 'xhigh']);
  run('create', { title: 'Plain' });
  assert.equal('model' in store.state.work['W-2'], false, 'records that ask for nothing carry nothing');
  run('triage', { work: 'W-2', bucket: 'ready', note: 'n', effort: 'high' });
  assert.deepEqual([store.state.work['W-2'].model ?? null, store.state.work['W-2'].effort], [null, 'high']);
  run('triage', { work: 'W-1', bucket: 'ready', note: 'n', model: 'default' });
  assert.deepEqual([store.state.work['W-1'].model, store.state.work['W-1'].effort], [null, 'xhigh']);
  assert.throws(() => run('triage', { work: 'W-1', bucket: 'ready', note: 'n', effort: 'max' }), /effort/);
  assert.throws(() => run('create', { title: 'x', model: 'gpt-9' }), /model/);
});

test("a record whose model or effort differs from its stream worker's restarts that worker first; a match dispatches", () => {
  let p = plan([w('W-1', { model: 'opus', effort: 'high' })]);
  assert.deepEqual([p['W-1'].action, p['W-1'].to, p['W-1'].want], ['retune', S1, { model: 'opus', effort: 'high' }], 'a model goes only to a Claude stream');
  p = plan([w('W-1', { model: 'opus', effort: 'high' })], { [S1]: { model: 'opus', effort: 'high' } });
  assert.equal(p['W-1'].action, 'queue');
  p = plan([w('W-1')], { [S1]: { model: 'opus', effort: 'high' }, [S2]: { model: null, effort: 'high' } });
  assert.equal(p['W-1'].action, 'retune', 'a record asking for nothing puts a tuned worker back to its defaults');
  assert.deepEqual(p['W-1'].want, { model: null, effort: null });
  p = plan([w('W-1', { effort: 'high', owner: S2, stream: S2, streamPin: { by: 'Alex' } })]);
  assert.deepEqual([p['W-1'].action, p['W-1'].to], ['retune', S2], 'effort alone suits Codex too');
  p = plan([w('W-1', { model: 'opus', owner: S2, stream: S2, streamPin: { by: 'Alex' } })]);
  assert.equal(p['W-1'].action, null);
  assert.match(p['W-1'].reason, /model/);
});

test('a host stream starts a fresh worker per job, so its dispatch carries the flags instead of a restart', () => {
  const p = plan([w('W-1', { repo: 'teamwork-mini-mcp', model: 'opus', effort: 'xhigh' })]);
  assert.equal(p['W-1'].action, 'queue');
  assert.match(p['W-1'].reason, /--model opus --effort xhigh/);
});

test("the sandbox's own config carries the settings: set when asked, removed for the default, other keys kept", () => {
  const base = JSON.stringify({ themeId: 1, hooks: { a: 1 } });
  const tuned = JSON.parse(claudeTuned(base, { model: 'opus', effort: 'xhigh' }));
  assert.deepEqual(tuned, { themeId: 1, hooks: { a: 1 }, model: 'opus', effortLevel: 'xhigh' });
  assert.deepEqual(JSON.parse(claudeTuned(JSON.stringify(tuned), { model: null, effort: null })), { themeId: 1, hooks: { a: 1 } });
  const toml = 'approval = "never"\n\n[tui]\nx = 1\n';
  const t = codexTuned(toml, { effort: 'high' });
  assert.equal(t, 'model_reasoning_effort = "high"\napproval = "never"\n\n[tui]\nx = 1\n', 'a top-level key goes before the first table');
  assert.equal(codexTuned(t, { effort: 'low' }), 'model_reasoning_effort = "low"\napproval = "never"\n\n[tui]\nx = 1\n');
  assert.equal(codexTuned(t, { effort: null }), toml);
});

test('the card names the model and effort a record asked for', async () => {
  const { boardView } = await import('../views/board.mjs');
  const store = openStore(':memory:');
  store.append({ kind: 'create', payload: { title: 'Deep', model: 'opus', effort: 'xhigh' } }, ctx);
  store.append({ kind: 'create', payload: { title: 'Plain' } }, ctx);
  const cards = boardView(store.state, {});
  assert.deepEqual(cards.map(c => c.tuning), ['opus · effort xhigh', null]);
});
