// Which worker a request from inside a sandbox speaks for. Sandboxes reach the factory only on its sandbox port, where
// a claimed seat (x-seat) is never honoured: the sandbox names itself and proves it with a token only the factory mints.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** The token a sandbox presents; the factory writes it into that sandbox's MCP config. */
export const sandboxToken = (secret, name) => createHmac('sha256', secret).update(String(name)).digest('hex');

/**
 * @param headers the request's headers @param workers {worker label: sandbox name} (data/sandboxes.json)
 * @returns the worker label, or null when the token doesn't match or the sandbox is no stream's worker
 */
export function sandboxSeat(headers, secret, workers) {
  const name = headers['x-sandbox'], token = String(headers['x-sandbox-token'] || '');
  if (!name || !secret) return null;
  const want = Buffer.from(sandboxToken(secret, name)), got = Buffer.from(token);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  return Object.entries(workers).find(([, box]) => box === name)?.[0] || null;
}
