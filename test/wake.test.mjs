import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wakePlan } from '../core/wake.mjs';

const state = msgs => ({ messages: Object.fromEntries(msgs.map(m => [m.id, { ackedAt: null, ...m }])) });

test('a seat is woken for new messages, reminded once, and not for acked ones', () => {
  const s = state([{ id: 'M-1', to: 'sup' }, { id: 'M-2', to: 'router', ackedAt: 'x' }]);
  assert.deepEqual(wakePlan(s, {}, 0), [{ seat: 'sup', ids: ['M-1'], reminder: false }]);
  const woken = { sup: { at: 0, ids: ['M-1'] } };
  assert.deepEqual(wakePlan(s, woken, 60000), []);
  assert.deepEqual(wakePlan(s, woken, 21 * 60000).map(w => w.reminder), [true]);
  assert.deepEqual(wakePlan(s, { sup: { ...woken.sup, reminded: true } }, 99 * 60000), []);
  assert.deepEqual(wakePlan(state([{ id: 'M-1', to: 'sup' }, { id: 'M-3', to: 'sup' }]), woken, 1000).map(w => w.ids), [['M-1', 'M-3']]);
});

test('the herdr wake adapter refuses to load in shadow mode', async () => {
  process.env.FACTORY_MODE = 'shadow';
  try { await assert.rejects(import(`../wake/herdr.mjs?shadow=${Date.now()}`), /disabled in shadow mode/); }
  finally { delete process.env.FACTORY_MODE; }
});
