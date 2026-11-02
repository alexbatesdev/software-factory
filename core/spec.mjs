// project-planning documents → what the factory needs from them. Pure: sources/planning.mjs reads the files from origin/main.
const front = text => Object.fromEntries((String(text).match(/^---\n([\s\S]*?)\n---/)?.[1] || '').split('\n').map(l => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(m => [m[1], m[2].trim()]));
const cells = line => line.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

/** Rows of every table under the `## <heading>` section whose first cell is a REQ ID. */
function reqRows(text, heading) {
  const body = String(text).split(new RegExp(`^## ${heading}\\s*$`, 'm'))[1]?.split(/^## /m)[0] || '';
  return body.split('\n').filter(l => /^\|\s*REQ-\d+\s*\|/.test(l)).map(cells);
}

/** @returns {teamworkTask, reqs: {REQ-n: {text, notes, devToVerify}}, acs: [{req, text}]} */
export function parseSpec(text) {
  const reqs = {};
  for (const [id, req, notes = ''] of reqRows(text, 'Requirements')) reqs[id] = { text: req, notes, devToVerify: /dev to verify/i.test(notes) };
  const acs = reqRows(text, 'Acceptance criteria').map(([req, ac]) => ({ req, text: ac }));
  return { teamworkTask: front(text).teamwork_task?.match(/tasks\/(\d+)/)?.[1] || null, reqs, acs };
}

/** @returns [{id: D-n, title, status, needs}] from a decisions.md */
export function parseDecisions(text) {
  return String(text).split(/^### /m).slice(1).map(block => {
    const [head] = block.split('\n'), field = k => block.match(new RegExp(`^- ${k}:\\s*(.*)$`, 'm'))?.[1].trim() || null;
    const m = head.match(/^(D-\d+)\s*[—-]\s*(.*)$/);
    return m && { id: m[1], title: m[2].trim(), status: field('status'), needs: field('needs') };
  }).filter(Boolean);
}
