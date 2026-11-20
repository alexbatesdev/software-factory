import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const ROOT = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 64 * 1024 * 1024;
const OUTPUT_LIMIT = 128 * 1024 * 1024;
const REQUEST_TIMEOUT = 120_000;
const compress = promisify(gzip);
const assets = new Map([['', ['index.html', 'text/html; charset=utf-8']], ['index.html', ['index.html', 'text/html; charset=utf-8']], ['viewer.mjs', ['viewer.mjs', 'text/javascript; charset=utf-8']], ['renderer.mjs', ['renderer.mjs', 'text/javascript; charset=utf-8']], ['style.css', ['style.css', 'text/css; charset=utf-8']]]);

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

class Worker {
  constructor(binary, project, allowCapture) {
    this.queue = []; this.active = null; this.chunks = []; this.bufferedBytes = 0; this.next = 1; this.closed = false; this.lastUsed = Date.now(); this.progress = null;
    const command = project.prepare ? [process.execPath, resolve(ROOT, 'pr-prepare.mjs'), '--progress'] : [binary, '--root', project.root, ...(project.manifest ? ['--comparison', project.manifest, '--progress'] : []), ...(!project.manifest && allowCapture ? ['--allow-capture'] : [])];
    this.deadline = project.prepare || project.manifest ? 240_000 : REQUEST_TIMEOUT;
    this.child = spawn(process.execPath, [resolve(ROOT, 'worker-host.mjs'), ...command], { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    this.exited = new Promise(done => this.child.once('close', done));
    this.child.on('error', () => this.fail(new HttpError(503, 'Megamap analysis worker could not start')));
    this.child.on('exit', () => this.fail(new HttpError(503, 'Megamap analysis worker stopped; retry to rebuild the index')));
    this.child.stderr.resume();
    this.child.stdout.on('data', chunk => this.receive(chunk));
    this.child.stdin.on('error', () => this.fail(new HttpError(503, 'Megamap analysis input closed')));
  }
  get busy() { return Boolean(this.active || this.queue.length); }
  request(payload) {
    if (this.closed) return Promise.reject(new HttpError(503, 'Megamap analysis worker is closed'));
    if (this.queue.length >= 16) return Promise.reject(new HttpError(503, 'Megamap project is busy; retry shortly'));
    this.lastUsed = Date.now();
    return new Promise((resolve, reject) => { this.queue.push({ id: this.next++, payload, resolve, reject }); this.pump(); });
  }
  pump() {
    if (this.active || this.closed || !this.queue.length) return;
    this.active = this.queue.shift();
    this.timer = setTimeout(() => { this.fail(new HttpError(504, 'Megamap analysis timed out')); this.terminate('SIGKILL'); }, this.deadline);
    this.timer.unref();
    const request = { ...this.active.payload, id: this.active.id };
    this.child.stdin.write(JSON.stringify(request) + '\n');
  }
  receive(chunk) {
    if (this.closed) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(10, start);
      const part = chunk.subarray(start, end < 0 ? chunk.length : end);
      this.bufferedBytes += part.length;
      if (this.bufferedBytes > OUTPUT_LIMIT) { this.fail(new HttpError(502, 'Megamap result exceeds the response limit')); this.terminate('SIGKILL'); return; }
      this.chunks.push(part);
      if (end < 0) return;
      const line = Buffer.concat(this.chunks, this.bufferedBytes);
      this.chunks = []; this.bufferedBytes = 0; start = end + 1;
      let value;
      try { value = JSON.parse(line.toString('utf8')); } catch { this.fail(new HttpError(502, 'Invalid analysis response')); this.terminate('SIGKILL'); return; }
      if (Object.hasOwn(value, 'progress')) {
        const p = value.progress;
        if ((value.id != null && value.id !== this.active?.id) || !p || typeof p.phase !== 'string' || typeof p.message !== 'string' || p.phase.length > 128 || p.message.length > 1024 || ['completed', 'total', 'elapsedMs'].some(k => p[k] !== undefined && (!Number.isSafeInteger(p[k]) || p[k] < 0))) { this.fail(new HttpError(502, 'Invalid analysis progress')); this.terminate('SIGKILL'); return; }
        this.progress = { phase: p.phase, message: p.message, completed: p.completed, total: p.total, elapsedMs: p.elapsedMs }; continue;
      }
      if (!this.active || value.id !== this.active.id || (!Object.hasOwn(value, 'result') && typeof value.error !== 'string')) { this.fail(new HttpError(502, 'Unexpected analysis response')); this.terminate('SIGKILL'); return; }
      clearTimeout(this.timer);
      const current = this.active; this.active = null;
      if (typeof value.error === 'string') current.reject(new HttpError(400, value.error.slice(0, 2048)));
      else current.resolve(value.result);
      this.pump();
    }
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true; this.error = error.message; clearTimeout(this.timer);
    if (this.active) this.active.reject(error);
    for (const job of this.queue) job.reject(error);
    this.active = null; this.queue = []; this.chunks = []; this.bufferedBytes = 0;
  }
  terminate(signal) {
    if (this.child.exitCode !== null || this.child.signalCode !== null || !this.child.pid) return;
    try { if (process.platform === 'win32') this.child.kill(signal); else process.kill(-this.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  async close() {
    this.fail(new HttpError(503, 'Megamap service is closing'));
    this.child.stdin.end();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.terminate('SIGTERM');
    const timer = setTimeout(() => this.terminate('SIGKILL'), 1000); timer.unref();
    await this.exited; clearTimeout(timer);
  }
}

function headers(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; object-src 'none'; base-uri 'self'");
}
async function json(res, status, data, req) {
  if (res.destroyed || res.writableEnded) return;
  let body = Buffer.from(JSON.stringify(data));
  if (body.length > OUTPUT_LIMIT) { status = 502; body = Buffer.from('{"error":"Megamap response exceeds the size limit"}'); }
  if (body.length > 1024 && /\bgzip\b/i.test(req.headers['accept-encoding'] || '') && !/gzip\s*;\s*q=0(?:\D|$)/i.test(req.headers['accept-encoding'] || '')) {
    body = await compress(body, { level: 1 });
    if (res.destroyed || res.writableEnded) return;
    res.setHeader('Content-Encoding', 'gzip'); res.setHeader('Vary', 'Accept-Encoding');
  }
  res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Content-Length', body.length); res.end(body);
}
function sameOrigin(req, publicAsset = false) {
  const host = req.headers.host;
  if (!host || !/^((127\.0\.0\.1)|(localhost)|(\[::1\])):\d+$/.test(host)) throw new HttpError(403, 'Megamap requires a loopback host');
  const origin = `http://${host}`;
  if (new URL(origin).port !== String(req.socket.localPort)) throw new HttpError(403, 'Megamap host does not match this server');
  if (publicAsset) return origin;
  if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Cross-origin Megamap requests are refused');
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new HttpError(403, 'Cross-site Megamap requests are refused');
  return origin;
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw new HttpError(415, 'Send application/json');
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) throw new HttpError(413, 'Megamap request exceeds 64 MiB');
  let size = 0; const chunks = [];
  const timer = setTimeout(() => req.destroy(new Error('Request body timed out')), 15_000); timer.unref();
  try {
    for await (const chunk of req) { size += chunk.length; if (size > BODY_LIMIT) throw new HttpError(413, 'Megamap request exceeds 64 MiB'); chunks.push(chunk); }
    let value;
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Invalid JSON'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Send a JSON object');
    return value;
  } finally { clearTimeout(timer); }
}
function nodeId(value) { if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, 'Invalid node ID'); return value; }

export async function createMegamapHandler({ prefix = '/megamap', projects = [], binary, allowCapture = false } = {}) {
  if (typeof binary !== 'string' || !binary) throw new Error('Configure an analysis worker path for Megamap');
  if (process.platform === 'win32') throw new Error('Megamap local worker hosting currently requires macOS or Linux');
  prefix = prefix.replace(/\/+$/, '');
  if (!/^\/[A-Za-z0-9/_-]+$/.test(prefix)) throw new Error('Invalid Megamap route prefix');
  if (!Array.isArray(projects) || !projects.length || projects.length > 128) throw new Error('Configure between 1 and 128 Megamap projects');
  const registry = new Map();
  for (const entry of projects) {
    if (!entry || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.id) || registry.has(entry.id)) throw new Error('Project IDs must be unique simple names');
    const root = await realpath(entry.root);
    if (!(await stat(root)).isDirectory()) throw new Error('Megamap project must be a directory');
    registry.set(entry.id, { id: entry.id, label: String(entry.label || entry.id).slice(0, 256), root, ...(entry.repository ? { repository: entry.repository } : {}) });
  }
  const token = randomBytes(32).toString('hex');
  const workers = new Map(), indexes = new Map(), comparisons = new Map(), preparing = new Map(); let closed = false;
  let acquisition = Promise.resolve();
  function requestWorker(project, payload, refresh = false) {
    const result = acquisition.then(async () => {
      if (closed) throw new HttpError(503, 'Megamap service is closed');
      if (project.manifest && !indexes.has(project.key)) throw new HttpError(404, 'PR comparison expired. Load the PR again.');
      if (refresh) { const key = project.key || project.id; const old = workers.get(key); if (old) { await old.close(); workers.delete(key); } }
      const current = await acquire(project);
      return { response: current.request(payload) };
    });
    acquisition = result.then(() => {}, () => {});
    return result.then(({ response }) => response);
  }
  async function acquire(project) {
    const key = project.key || project.id;
    const previous = workers.get(key);
    if (previous && !previous.closed) return previous;
    if (previous) { await previous.close(); workers.delete(key); }
    if (workers.size >= 4) {
      const idle = [...workers].filter(([key, w]) => !w.busy && ![...preparing.values()].some(r => r.index?.key === key)).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
      if (!idle) throw new HttpError(503, 'All Megamap analysis slots are busy');
      await discardWorker(idle[0]);
    }
    if (closed) throw new HttpError(503, 'Megamap service is closed');
    const next = new Worker(binary, project, allowCapture); workers.set(key, next); return next;
  }
  async function discardWorker(key) {
    const old = workers.get(key); if (old) { await old.close(); workers.delete(key); }
    for (const [id, comparison] of comparisons) if (comparison.key === key) comparisons.delete(id);
    const index = indexes.get(key); indexes.delete(key);
    if (index) await rm(index.directory, { recursive: true, force: true });
  }
  function resolveComparison(project, id) {
    if (!id) return project;
    const comparison = comparisons.get(id);
    if (!/^[a-f0-9]{32}$/.test(id) || !comparison || comparison.projectId !== project.id) throw new HttpError(404, 'PR comparison expired or belongs to another project. Load the PR again.');
    comparison.lastUsed = Date.now(); return comparison;
  }
  function decorate(view, session) {
    if (view.pr) view.pr = { ...view.pr, ...session.pr };
    return view;
  }
  function prepare(project, number, options = {}) {
    if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw new HttpError(400, 'PR number must be a positive integer');
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new HttpError(400, 'PR options must be an object');
    let record = preparing.get(project.id);
    if (record && (record.number !== number || record.callers >= 16) || !record && preparing.size >= 2) throw new HttpError(503, 'PR preparation is busy. Retry when the current load finishes.');
    if (!record) {
      record = { number, started: Date.now(), callers: 0 }; preparing.set(project.id, record);
      record.promise = (async () => {
        let directory, index, created = false;
        try {
          if (closed) throw new HttpError(503, 'Megamap service is closed');
          record.worker = new Worker(binary, { ...project, prepare: true }, false);
          const configured = { root: project.root, ...(project.repository ? { repository: project.repository } : {}) };
          const resolved = await record.worker.request({ op: 'resolve', project: configured, number });
          if (closed) throw new HttpError(503, 'Megamap service is closed');
          const pr = resolved.pr;
          if (!pr || pr.number !== number || ![pr.baseSha, pr.mergeBaseSha, pr.headSha].every(sha => typeof sha === 'string' && /^[a-f0-9]{40,64}$/.test(sha))) throw new HttpError(502, 'Invalid PR revision metadata');
          const key = JSON.stringify([project.id, number, pr.baseSha, pr.mergeBaseSha, pr.headSha]);
          index = indexes.get(key);
          if (index && workers.get(key)?.closed !== false) { await discardWorker(key); index = null; }
          if (!index) {
            directory = await mkdtemp(resolve(tmpdir(), 'spamton-megamap-pr-'));
            const result = await record.worker.request({ op: 'prepare', project: configured, number, directory, resolved });
            if (closed) throw new HttpError(503, 'Megamap service is closed');
            if (result.directory !== directory || result.manifest !== resolve(directory, 'comparison.json') || result.root !== resolve(directory, 'after')) throw new HttpError(502, 'Invalid PR preparation result');
            index = { ...project, ...result, projectId: project.id, key }; created = true;
            indexes.set(key, index); record.index = index;
            await record.worker.close(); record.worker = null;
            await requestWorker(index, { op: 'ready' });
          }
          record.index = index;
          return { index, pr };
        } catch (error) {
          if (record.worker) { await record.worker.close(); record.worker = null; }
          if (created) await discardWorker(index.key);
          else if (directory) await rm(directory, { recursive: true, force: true });
          throw error;
        } finally { if (record.worker) { await record.worker.close(); record.worker = null; } }
      })();
    }
    record.callers++;
    return (async () => {
      let id;
      try {
        const { index, pr } = await record.promise;
        if (closed) throw new HttpError(503, 'Megamap service is closed');
        while (comparisons.size >= 16) {
          const idle = [...comparisons].filter(([, c]) => !c.active).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
          if (!idle) throw new HttpError(503, 'All PR sessions are busy');
          comparisons.delete(idle[0]);
        }
        id = randomBytes(16).toString('hex');
        const session = { ...index, pr, options: {}, lastUsed: Date.now(), active: 1 };
        comparisons.set(id, session);
        try {
          const view = await requestWorker(session, { op: 'view', options, previousOptions: session.options });
          session.options = view.contextOptions || {};
          return { comparison: id, view: decorate(view, session) };
        } finally { session.active--; }
      } catch (error) { if (id) comparisons.delete(id); throw error; }
      finally { if (--record.callers === 0 && preparing.get(project.id) === record) preparing.delete(project.id); }
    })();
  }
  return {
    async handle(req, res) {
      const raw = req.url || '/';
      const path = raw.split('?')[0];
      if (path !== prefix && !path.startsWith(prefix + '/')) return false;
      headers(res);
      try {
        if (closed) throw new HttpError(503, 'Megamap service is closed');
        const route = path === prefix ? '' : path.slice(prefix.length + 1);
        const origin = sameOrigin(req, path === prefix || assets.has(route)); const url = new URL(raw, origin);
        if (path === prefix) { if (req.method !== 'GET') throw new HttpError(405, 'Use GET'); res.writeHead(302, { Location: prefix + '/' + url.search }); res.end(); return true; }
        if (assets.has(route)) {
          if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Use GET');
          const [name, type] = assets.get(route); const bytes = await readFile(resolve(ROOT, name));
          res.statusCode = 200; res.setHeader('Content-Type', type); res.setHeader('Content-Length', bytes.length); res.end(req.method === 'HEAD' ? undefined : bytes); return true;
        }
        if (!route.startsWith('api/')) throw new HttpError(404, 'No such Megamap asset');
        if (route === 'api/config' && req.method === 'GET') {
          await json(res, 200, { token, capabilities: { capture: Boolean(allowCapture), pr: true }, projects: [...registry.values()].map(({ id, label }) => ({ id, label })) }, req); return true;
        }
        const supplied = req.headers['x-megamap-token'];
        if (typeof supplied !== 'string' || !/^([a-f0-9]{64})$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) throw new HttpError(403, 'Missing Megamap request token');
        const project = registry.get(url.searchParams.get('project'));
        if (!project) throw new HttpError(404, 'Unknown configured project');
        const selected = route === 'api/pr' ? project : resolveComparison(project, url.searchParams.get('comparison'));
        if (route === 'api/status' && req.method === 'GET') {
          const record = preparing.get(project.id), w = workers.get(selected.key || selected.id), analyzing = record?.index && workers.get(record.index.key);
          const loading = Boolean(w?.busy || record), progress = analyzing?.progress || record?.worker?.progress || w?.progress;
          const elapsedMs = record ? Date.now() - record.started : undefined;
          await json(res, 200, { loading, message: loading ? (progress?.message || (record ? 'Checking pinned PR revisions…' : 'Analyzing repository…')) : '', progress: loading ? progress : null, elapsedMs, error: w?.error || null }, req); return true;
        }
        let payload;
        if (route === 'api/source' && req.method === 'GET') {
          const rawNode = url.searchParams.get('node'); if (!/^\d+$/.test(rawNode || '')) throw new HttpError(400, 'Invalid node ID');
          const syntax = url.searchParams.get('syntax'); if (syntax !== null && syntax !== '0' && syntax !== '1') throw new HttpError(400, 'Invalid syntax flag');
          payload = { op: 'source', node: nodeId(Number(rawNode)), syntax: syntax !== '0' };
        } else {
          if (req.method !== 'POST') throw new HttpError(405, 'Use POST for this operation');
          const value = await body(req);
          if (route === 'api/pr') { await json(res, 200, await prepare(project, value.number, value.options), req); return true; }
          if (selected.manifest && route !== 'api/view') throw new HttpError(409, 'PR snapshots are immutable. Reload the PR or exit PR mode to use this control.');
          if (route === 'api/view' || route === 'api/refresh') payload = { op: 'view', options: route === 'api/refresh' ? { ...value, traceRoot: null, direction: 'all', evidence: 'all' } : value };
          else if (route === 'api/expand') payload = { op: 'expand', node: nodeId(value.node) };
          else if (route === 'api/evidence') { if (value.snapshot !== null && typeof value.snapshot !== 'string') throw new HttpError(400, 'Supply snapshot JSON or null'); payload = { op: 'evidence', snapshot: value.snapshot }; }
          else if (route === 'api/capture') { if (!allowCapture) throw new HttpError(403, 'Rails capture is disabled; import a snapshot instead'); payload = { op: 'capture' }; }
          else throw new HttpError(404, 'Unknown Megamap operation');
        }
        if (selected.manifest) {
          if (payload.op === 'source') payload.contextOptions = selected.options;
          else payload.previousOptions = selected.options;
          selected.active++;
        }
        try {
          const result = await requestWorker(selected, payload, route === 'api/refresh');
          if (selected.manifest && payload.op === 'view') { selected.options = result.contextOptions || selected.options; decorate(result, selected); }
          await json(res, 200, result, req);
        } finally { if (selected.manifest) selected.active--; }
      } catch (error) { await json(res, error.status || 500, { error: error.status ? error.message : 'Megamap service could not complete the request' }, req); }
      return true;
    },
    async close() {
      closed = true;
      const pending = [...preparing.values()];
      await Promise.all([...pending.map(record => record.worker), ...workers.values()].filter(Boolean).map(w => w.close()));
      await Promise.allSettled(pending.map(record => record.promise));
      workers.clear();
      await Promise.all([...indexes.values()].map(c => rm(c.directory, { recursive: true, force: true }))); indexes.clear(); comparisons.clear();
    },
  };
}

