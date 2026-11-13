// Configuration preflight (evolution phase 1 step 3): what in config.json the runtime would trip on, checked against
// the rules the runtime already uses. A record's model on a Codex stream is dispatch's check (dispatch.mjs), not this one.
const AGENTS = ['claude', 'codex'];
const W_ID = /^W-\d+$/;

/** @returns {string[]} problems, empty when the config is usable. exists(path) checks a file (~ already expanded). */
export function checkConfig(config, { roles, exists, home = '' }) {
  const out = [], file = p => String(p).replace(/^~\//, `${home}/`);
  for (const [seat, role] of Object.entries(config.roles || {})) if (!roles[role]) out.push(`roles: "${seat}" has role "${role}", which capabilities.mjs doesn't define`);
  for (const [sup, s] of Object.entries(config.routing?.supervisors || {})) {
    if (s.worker && !/^sbx: /.test(s.worker)) out.push(`routing: ${sup}'s worker "${s.worker}" isn't an "sbx: <stream>" label`);
    if (s.agent && !AGENTS.includes(s.agent)) out.push(`routing: ${sup} runs agent "${s.agent}"; the factory knows ${AGENTS.join(' and ')}`);
    if (s.howTo && !exists(file(s.howTo))) out.push(`routing: ${sup}'s howTo ${s.howTo} doesn't exist`);
  }
  if (config.recycle?.enabled !== false && config.recycle?.host && !exists(new URL(`../hosts/${config.recycle.host}.mjs`, import.meta.url).pathname)) out.push(`recycle: host adapter hosts/${config.recycle.host}.mjs doesn't exist`);
  for (const s of config.factory?.seats || []) if (s.role && !roles[s.role]) out.push(`factory: seat "${s.label}" starts role "${s.role}", which capabilities.mjs doesn't define`);
  for (const id of config.autoDispatch?.exclude || []) if (!W_ID.test(id)) out.push(`autoDispatch.exclude: "${id}" isn't a W-n`);
  return out;
}
