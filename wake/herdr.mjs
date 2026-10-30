// Live wake: types one line into the seat's pane when it is idle. Refuses to load in shadow mode, so a shadow run can't type.
import { resolveTarget } from '../core/notifier.mjs';
import { wakeText } from '../core/wake.mjs';
import { herdrRaw } from '../fleet/herdr.mjs';

if (process.env.FACTORY_MODE === 'shadow') throw new Error('The herdr wake adapter is disabled in shadow mode.');

// herdr's agent list has no pane labels; seats are labels, so join the pane list.
async function agents() {
  const [{ agents }, { panes }] = await Promise.all([herdrRaw('agent', 'list'), herdrRaw('pane', 'list')]);
  const label = new Map(panes.map(p => [p.pane_id, p.label]));
  return agents.map(a => ({ ...a, label: label.get(a.pane_id) || null }));
}

/** Wake one seat if it can take a prompt now; a busy or missing seat is retried by the next tick. */
export async function wake(w) {
  const h = resolveTarget(await agents(), w.seat);
  if (!h.ok) return { ok: false, reason: h.defer || h.reason };
  const r = await herdrRaw('agent', 'prompt', h.agent.pane_id, wakeText(w));
  return r?.type === 'agent_prompted' ? { ok: true } : { ok: false, reason: `herdr did not confirm: ${JSON.stringify(r).slice(0, 200)}` };
}
