// W-568: when the Mac sleeps, fetch's pooled HTTP/2 connections die but stay in the pool, and every request on them hangs
// until undici's 300 s headers timeout (Teamwork failed that way from the 11-19 16:10Z wake on). A fresh pool fixes it.
const POOL = Symbol.for('undici.globalDispatcher.2');

/** How long the process was suspended, judged by a heartbeat arriving far later than due; 0 when it wasn't. */
export const missedMs = (lastMs, nowMs, everyMs, graceMs = 60000) => (nowMs - lastMs - everyMs > graceMs ? nowMs - lastMs - everyMs : 0);

/** Swap in a fresh global fetch pool; the old one is destroyed so requests hung on it fail now. */
export function freshPool(g = globalThis) {
  const old = g[POOL];
  if (!old?.constructor) return false;
  g[POOL] = new old.constructor();
  Promise.resolve(old.destroy?.()).catch(() => {});
  return true;
}
