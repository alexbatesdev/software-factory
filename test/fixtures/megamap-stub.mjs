// A stand-in for megamap's web/server.mjs (contract v1): async like the real one, answers under its prefix with the options it was given.
export async function createMegamapHandler(opts) {
  let closed = false;
  return {
    async handle(req, res) {
      const url = new URL(req.url, 'http://x');
      if (url.pathname !== opts.prefix && !url.pathname.startsWith(`${opts.prefix}/`)) return false;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ stub: true, path: url.pathname, projects: opts.projects, binary: opts.binary, allowCapture: opts.allowCapture }));
      return true;
    },
    async close() { closed = true; },
    get closed() { return closed; },
  };
}
