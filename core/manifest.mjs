// What a run ran with (evolution phase 1 step 3): one manifest per started attempt, recorded when the factory sees it
// start. Instruction files are kept by hash in the artifact store, so a later reader sees the text that was used.
import { createHash } from 'node:crypto';
import { looksSecret, parseLink, storeBytes } from './artifacts.mjs';

export const MANIFEST_KINDS = ['manifest'];
export const MANIFEST_FROM = '2026-11-13T16:00:00.000Z';
const UNAVAILABLE = 'unavailable';

export function foldManifest(state, { payload: p, ctx }) {
  state.manifests ??= {};
  state.manifests[p.key] = { ...p, at: ctx.now };
  return p.key;
}

const attemptsOf = a => (a.history || []).filter(h => h.status === 'started');

/** Started attempts since MANIFEST_FROM with no manifest yet. */
export function manifestsDue(state) {
  const out = [];
  for (const w of Object.values(state.work))
    for (const a of w.assignments || []) attemptsOf(a).forEach((h, i) => {
      const key = `${w.id}/${a.id}/${i + 1}`;
      if (h.at >= MANIFEST_FROM && !state.manifests?.[key]) out.push({ w, a, attempt: i + 1, key });
    });
  return out;
}

/**
 * io: {root, now(), home, factoryVersion, config (text), instructions {name: path}, read(path) → Buffer,
 *      harness(stream) → {agent, sandbox, model, effort} | null}
 */
export async function captureManifests(store, io) {
  for (const { w, a, attempt, key } of manifestsDue(store.state)) {
    const briefPath = a.brief || (parseLink(a.evidence).from === 'host' ? parseLink(a.evidence).path : null);
    const files = { ...(briefPath ? { brief: briefPath.replace(/^~\//, `${io.home}/`) } : {}), ...io.instructions };
    const instructions = [];
    for (const [name, path] of Object.entries(files)) {
      try {
        const bytes = await io.read(path);
        instructions.push(looksSecret(bytes) ? { name, path, sha256: null, unavailable: 'withheld: looks like it holds a credential' } : { name, path, sha256: storeBytes(io.root, bytes) });
      } catch (e) { instructions.push({ name, path, sha256: null, unavailable: String(e.message).slice(0, 200) }); }
    }
    const h = io.harness(w.stream) || {};
    store.append({ kind: 'manifest', payload: { key,
      run: { work: w.id, assignment: a.id, version: a.version ?? null, attempt, kind: a.kind, owner: a.owner || null, stream: w.stream || null },
      startHead: a.startedFrom?.head || w.head || null, pr: w.links?.pr || null, factoryVersion: io.factoryVersion || UNAVAILABLE,
      config: createHash('sha256').update(io.config).digest('hex'),
      harness: { agent: h.agent || UNAVAILABLE, sandbox: h.sandbox || null,
        model: { requested: h.model ?? null, observed: UNAVAILABLE }, effort: { requested: h.effort ?? null, observed: UNAVAILABLE } },
      instructions } }, { now: io.now(), by: 'board (manifest)' });
  }
}
