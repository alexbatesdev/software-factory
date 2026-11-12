import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../core/store.mjs';
import { autoReadyTick } from '../effects/pr-ready.mjs';

const PR = 'https://github.com/builtforteams/built-rails/pull/9001';
const ctx = { now: '2026-11-04T12:00:00.000Z', by: 'test' };
const standing = { by: 'Alex', at: '2026-10-28' };

function readyRecord() {
  const s = openStore();
  const id = s.append({ kind: 'create', payload: { title: 'Fix it', kind: 'build', links: { pr: PR } } }, ctx).id;
  const ev = p => s.append({ kind: 'event', target: id, payload: p }, ctx);
  for (const to of ['ready', 'queued', 'implementation']) ev({ type: 'transition', to, owner: 'sbx: stream-1' });
  ev({ type: 'implementation_done', head: 'aaa1111' });
  s.append({ kind: 'observe_head', target: id, payload: { sha: 'aaa1111', via: 'github', isDraft: true } }, ctx);
  ev({ type: 'review', head: 'aaa1111', by: 'reviewer', result: 'clean' });
  if (s.state.work[id].phase !== 'ready_for_human') ev({ type: 'mark_ready' });
  assert.equal(s.state.work[id].phase, 'ready_for_human');
  return { s, id };
}
const fakeGh = (pr, { readyThrows = false, moveTo = null } = {}) => ({
  calls: 0,
  async view() { return { ...pr }; },
  async ready() { this.calls++; if (readyThrows) throw new Error('gh failed'); if (moveTo) pr.head = moveTo; pr.isDraft = false; },
});

test('a clean internal review marks the PR ready once, confirmed by a readback', async () => {
  const { s, id } = readyRecord(), gh = fakeGh({ head: 'aaa1111', isDraft: true });
  await autoReadyTick(s, gh, { standing, now: () => ctx.now });
  await autoReadyTick(s, gh, { standing, now: () => ctx.now });
  assert.equal(gh.calls, 1);
  assert.equal(s.state.work[id].prReadyOps.at(-1).status, 'confirmed');
  assert.equal(s.state.work[id].phase, 'awaiting_human_approval');
});

test('a failed mark at this head is not retried', async () => {
  const { s, id } = readyRecord(), gh = fakeGh({ head: 'aaa1111', isDraft: true }, { readyThrows: true });
  await autoReadyTick(s, gh, { standing, now: () => ctx.now });
  await autoReadyTick(s, gh, { standing, now: () => ctx.now });
  assert.equal(gh.calls, 1);
  assert.equal(s.state.work[id].prReadyOps.at(-1).status, 'failed');
});

test('a head that moved around the mutation is uncertain, and the reconcile never mutates GitHub', async () => {
  const { s, id } = readyRecord(), gh = fakeGh({ head: 'aaa1111', isDraft: true }, { moveTo: 'bbb2222' });
  await autoReadyTick(s, gh, { standing, now: () => ctx.now });
  assert.equal(s.state.work[id].prReadyOps.at(-1).status, 'uncertain');
  await autoReadyTick(s, gh, { standing, now: () => ctx.now });
  assert.equal(gh.calls, 1);
});

test('a PR GitHub reads at another head is refused before any mutation', async () => {
  const { s, id } = readyRecord(), gh = fakeGh({ head: 'ccc3333', isDraft: true });
  const logs = [];
  await autoReadyTick(s, gh, { standing, now: () => ctx.now, log: l => logs.push(l) });
  assert.equal(gh.calls, 0);
  assert.equal(s.state.work[id].prReadyOps.length, 0);
  assert.match(logs[0], /refused/);
});

test('without the standing authorization nothing is marked', async () => {
  const { s } = readyRecord(), gh = fakeGh({ head: 'aaa1111', isDraft: true });
  await autoReadyTick(s, gh, { standing: null, now: () => ctx.now });
  assert.equal(gh.calls, 0);
});

test('a question filed on a record awaiting approval leaves it awaiting: the PR evidence has not changed (W-446: W-440 stranded in rereview by TB-227)', async () => {
  const { s, id } = readyRecord(), gh = fakeGh({ head: 'aaa1111', isDraft: true });
  await autoReadyTick(s, gh, { standing, now: () => ctx.now });
  assert.equal(s.state.work[id].phase, 'awaiting_human_approval');
  s.append({ kind: 'ask', payload: { title: 'Confirm in prod before replying on Teamwork?', options: ['run it', 'skip'], recommend: 'run it', work: id, promptedBy: 'F2', wwbd: 'checked', why: 'prod only', recommendWhy: 'cheap' } }, { now: '2026-11-12T07:00:00.000Z', by: 'sup: stream-2' });
  assert.equal(s.state.work[id].phase, 'awaiting_human_approval');
});
