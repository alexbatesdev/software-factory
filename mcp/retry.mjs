// A board restart takes seconds; a seat's call made meanwhile waits for it instead of failing (W-499).
// A refused connection never reached the server, so any call is resent; other breaks resend reads only.
const WAITS = [1000, 2000, 4000, 8000, 15000, 30000, 30000];

export async function boardFetch(url, opts = {}, { fetch: f = fetch, waits = WAITS, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const read = !opts.method || opts.method === 'GET';
  for (let i = 0; ; i++) {
    try { return await f(url, opts); } catch (e) {
      const code = e.cause?.code;
      if (!(code === 'ECONNREFUSED' || (read && /ECONNRESET|UND_ERR_SOCKET|ETIMEDOUT/.test(code || '')))) throw e;
      if (i >= waits.length) throw new Error(`The board at ${url} is not answering (${code}); it may be mid-restart. Try again in a minute, or ask the board lead if it stays down.`);
      await sleep(waits[i]);
    }
  }
}
