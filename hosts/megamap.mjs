// The megamap web viewer (W-574) mounted in the factory's own origin. Its projects are configured ids mapped to local
// roots, so no path ever comes from HTTP. It is optional: a missing module, binary or root serves an "unavailable" page
// under the prefix, and the factory runs either way.
import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { homedir } from 'node:os';

const PREFIX = '/megamap';
const REPO = fileURLToPath(new URL('..', import.meta.url));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const under = (req, prefix) => { const p = new URL(req.url, 'http://x').pathname; return p === prefix || p.startsWith(`${prefix}/`); };

function unavailable(prefix, missing) {
  return {
    available: false, missing,
    async handle(req, res) {
      if (!under(req, prefix)) return false;
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><meta charset="utf-8"><title>Megamap unavailable</title><body style="font:14px system-ui;padding:24px">
<h1 style="font-size:18px">Megamap isn't available</h1><p>The factory is configured for it, but:</p><ul>${missing.map(m => `<li>${esc(m)}</li>`).join('')}</ul>
<p>Install it at the path in <code>config.megamap</code>, then restart the factory. <a href="/">Back to the board</a></p></body>`);
      return true;
    },
    async close() {},
  };
}

/**
 * @param cfg config.megamap: {module, binary, allowCapture, projects: [{id, label, root, repo}]}, or nothing
 * @returns null when not configured, else {available, missing, projects, handle(req, res) → boolean, close()}
 */
export async function megamapMount(raw, { exists = existsSync, load = p => import(pathToFileURL(p).href) } = {}) {
  if (!raw) return null;
  // A relative path is inside this repo (W-636: tools/megamap).
  const home = p => { const x = String(p || '').replace(/^~(?=\/)/, homedir()); return x && !isAbsolute(x) ? resolve(REPO, x) : x; };
  const cfg = { ...raw, module: raw.module && home(raw.module), binary: raw.binary && home(raw.binary), projects: (raw.projects || []).map(p => ({ ...p, root: home(p.root) })) };
  const prefix = cfg.prefix || PREFIX;
  const projects = (cfg.projects || []).filter(p => exists(p.root));
  const missing = [...(cfg.projects || []).filter(p => !exists(p.root)).map(p => `project ${p.id}: no checkout at ${p.root}`),
    ...(!cfg.module || !exists(cfg.module) ? [`module: nothing at ${cfg.module}`] : []), ...(!cfg.binary || !exists(cfg.binary) ? [`binary: nothing at ${cfg.binary}`] : [])];
  if (!cfg.module || !exists(cfg.module) || !cfg.binary || !exists(cfg.binary) || !projects.length) return unavailable(prefix, missing.length ? missing : ['no project root exists']);
  try {
    const h = await (await load(cfg.module)).createMegamapHandler({ prefix, projects: projects.map(({ id, label, root }) => ({ id, label, root })), binary: cfg.binary, allowCapture: !!cfg.allowCapture });
    return { available: true, missing, projects, handle: (req, res) => h.handle(req, res), close: () => h.close() };
  } catch (e) { return unavailable(prefix, [...missing, `module failed to load: ${e.message}`]); }
}

/** The configured megamap project for a record's repo (no repo: the default one), or null. */
export const projectFor = (cfg, w, defaultRepo = 'built-rails') => (cfg?.projects || []).find(p => p.repo === (w.repo || defaultRepo)) || null;

/** A mount that, while unavailable, tries again on a /megamap/ request at most every `everyMs`, so installing needs no restart. */
export async function retryingMount(raw, { mount = megamapMount, clock = Date.now, everyMs = 30000, log = () => {} } = {}) {
  let m = await mount(raw), at = clock();
  const prefix = raw?.prefix || PREFIX;
  return {
    get available() { return !!m?.available; }, get missing() { return m?.missing || []; }, get projects() { return m?.projects || []; },
    async handle(req, res) {
      if (m && !m.available && under(req, prefix) && clock() - at >= everyMs) { at = clock(); m = await mount(raw); if (m?.available) log(`megamap: mounted at ${prefix}/ (${m.projects.map(p => p.id).join(', ')})`); }
      return m ? m.handle(req, res) : false;
    },
    async close() { await m?.close(); },
  };
}

/** W-597: the Megamap PR view for a record's PR, when its repo is a configured project; the project comes from config only. */
export function prMapFor(cfg, w) {
  const m = String(w.links?.pr || '').match(/github\.com\/[\w.-]+\/([\w.-]+)\/pull\/(\d+)/), p = m && (cfg?.projects || []).find(x => x.repo === m[1]);
  return p ? `${PREFIX}/?project=${encodeURIComponent(p.id)}&pr=${m[2]}` : null;
}
