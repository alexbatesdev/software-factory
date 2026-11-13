// Review evidence kept by the factory (evolution phase 1 step 2): a report a review links is copied by its sha256
// into the artifact root, so it survives the worker, its sandbox and later edits to the original file.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const ARTIFACT_KINDS = ['artifact'];
export const ARTIFACTS_FROM = '2026-11-13T00:00:00.000Z';
export const MAX_ATTEMPTS = 3;
const MAX_BYTES = 5 << 20;
const EXT = '(?:md|txt|log|json|png)';
const SECRET = /ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|sk-[A-Za-z0-9_-]{20,}/;

/** Where a review's link points: a host file, a file in the worker's sandbox checkout, or prose with no file. */
export function parseLink(link) {
  const s = String(link || '');
  const host = s.match(new RegExp(`(?:^|\\s)((?:/|~/)[^\\s)]+\\.${EXT})\\b`));
  if (host) return { from: 'host', path: host[1] };
  const rel = s.match(new RegExp(`(?:^|\\s)((?:\\.?[\\w-]+/)+[\\w.-]+\\.${EXT})\\b`));
  return rel ? { from: 'sandbox', path: rel[1] } : { from: 'none' };
}

/** Apply one artifact row: one entry per (work, head, link), updated in place as attempts are made. */
export function foldArtifact(state, { payload: p, ctx }) {
  state.artifacts ??= {};
  const prev = state.artifacts[p.key];
  state.artifacts[p.key] = { key: p.key, work: p.work, head: p.head, link: p.link, from: p.from || null, status: p.status,
    sha256: p.sha256 || null, bytes: p.bytes ?? null, found: p.found || null, detail: p.detail || null,
    attempts: (prev?.attempts || 0) + (p.status === 'failed' ? 1 : 0), at: ctx.now };
  return p.key;
}

const keyOf = (w, r) => `${w.id}@${r.head}:${r.link}`;

/** Reviews since ARTIFACTS_FROM whose link has no settled artifact yet (failed ones until MAX_ATTEMPTS). */
export function pendingArtifacts(state) {
  const out = [];
  for (const w of Object.values(state.work))
    for (const r of w.reviews || []) {
      if (!r.link || r.at < ARTIFACTS_FROM) continue;
      const a = state.artifacts?.[keyOf(w, r)];
      if (!a || (a.status === 'failed' && a.attempts < MAX_ATTEMPTS)) out.push({ w, r, key: keyOf(w, r) });
    }
  return out;
}

/**
 * Copy each pending review's report into `root` and record it.
 * io: {readHost(path) → Buffer, readSandbox(stream, relPath) → {bytes, found}, now(), root, only?(w) → bool}
 */
export async function retainArtifacts(store, io) {
  for (const { w, r, key } of pendingArtifacts(store.state)) {
    if (io.only && !io.only(w)) continue;
    const at = parseLink(r.link), base = { key, work: w.id, head: r.head, link: r.link, from: at.from };
    const record = p => store.append({ kind: 'artifact', payload: { ...base, ...p } }, { now: io.now(), by: 'board (artifacts)' });
    if (at.from === 'none') { record({ status: 'no_file' }); continue; }
    try {
      const got = at.from === 'host' ? { bytes: await io.readHost(at.path), found: at.path } : await io.readSandbox(w.stream, at.path);
      const bytes = Buffer.from(got.bytes);
      if (bytes.length > MAX_BYTES) { record({ status: 'failed', detail: `${bytes.length} bytes is over the ${MAX_BYTES}-byte limit` }); continue; }
      if (SECRET.test(bytes.toString('utf8'))) { record({ status: 'withheld', found: got.found, detail: 'looks like it holds a credential; not stored' }); continue; }
      const sha256 = createHash('sha256').update(bytes).digest('hex'), dir = join(io.root, sha256.slice(0, 2));
      if (!existsSync(join(dir, sha256))) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, sha256), bytes); }
      record({ status: 'retained', sha256, bytes: bytes.length, found: got.found });
    } catch (e) { record({ status: 'failed', detail: String(e.message).slice(0, 300) }); }
  }
}

/** Streams with a sandbox report not yet copied: their worker isn't recycled until it is. */
export const unretainedStreams = state => new Set(pendingArtifacts(state).filter(x => parseLink(x.r.link).from === 'sandbox').map(x => x.w.stream));
