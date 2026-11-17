import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardFetch } from '../mcp/retry.mjs';

// W-499: a board restart (11-16 ~18:46Z) made sup: stream-1's calls fail with "fetch failed" until it asked another seat.
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
const reset = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
const fake = fails => { let n = 0; const f = async () => { n++; if (fails.length) throw fails.shift()(); return { ok: true }; }; f.calls = () => n; return f; };
const noWait = { waits: [0, 0, 0], sleep: async () => {} };

test('a call made while the board restarts is retried until the board answers', async () => {
  const f = fake([refused, refused]);
  assert.deepEqual(await boardFetch('u', { method: 'POST' }, { ...noWait, fetch: f }), { ok: true });
  assert.equal(f.calls(), 3);
});

test('an action whose connection broke after it was sent is not resent (it may have landed); a read is', async () => {
  await assert.rejects(boardFetch('u', { method: 'POST' }, { ...noWait, fetch: fake([reset]) }), /fetch failed/);
  assert.deepEqual(await boardFetch('u', {}, { ...noWait, fetch: fake([reset]) }), { ok: true });
});

test('a board that stays down still fails, after the waits, saying so', async () => {
  await assert.rejects(boardFetch('u', {}, { ...noWait, fetch: fake([refused, refused, refused, refused]) }), /factory at u is not answering .*restart/i);
});
