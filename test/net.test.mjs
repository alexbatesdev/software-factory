// W-568: after the Mac sleeps, fetch's pooled connections are dead but still pooled, and every request hangs until its
// 300 s timeout. The server notices the gap and swaps in a fresh pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { missedMs, freshPool } from '../hosts/net.mjs';

test('a heartbeat that comes back long after it was due means the process was suspended', () => {
  assert.equal(missedMs(0, 30000, 30000), 0, 'on time');
  assert.equal(missedMs(0, 80000, 30000), 0, 'a busy event loop under a minute late is not sleep');
  assert.equal(missedMs(0, 30000 + 3600000, 30000), 3600000);
});

test("a fresh pool replaces fetch's global one and destroys the old, so requests hung on it fail at once", async () => {
  const POOL = Symbol.for('undici.globalDispatcher.2');
  class Pool { constructor() { this.destroyed = false; } async destroy() { this.destroyed = true; } }
  const old = new Pool(), g = { [POOL]: old };
  assert.equal(freshPool(g), true);
  assert.ok(g[POOL] instanceof Pool && g[POOL] !== old);
  await new Promise(r => setImmediate(r));
  assert.equal(old.destroyed, true);
  assert.equal(freshPool({}), false, 'no pool yet: nothing to replace');
});
