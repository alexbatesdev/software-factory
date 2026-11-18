// Outcomes by agent (W-558, Alex 11-18): how Claude and Codex jobs and the PRs they built fared, from what the factory
// already records. Pure: the server or bin/outcomes.mjs supplies the state and writes the report.
import { sumTokens } from './usage.mjs';

const FEEDBACK = ['threads', 'changes_requested', 'comments'];
const streamOf = owner => String(owner || '').replace(/^(sbx|sup): /, '');
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length ? Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null; };
const mean = xs => xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length * 100) / 100 : null;

/** The agent a job ran on: its manifest when that says, else its stream and the time that stream went Codex. */
function agentOf(state, w, a, start, codexSince) {
  const m = state.manifests?.[`${w.id}/${a.id}/1`]?.harness?.agent;
  if (m && m !== 'unavailable') return m;
  const since = codexSince[streamOf(a.owner)];
  return since && start >= since ? 'codex' : 'claude';
}

/**
 * @param cfg {since, until, codexSince: {stream: iso}} stream names without the sbx:/sup: prefix
 * @returns {jobs: [{agent, kind, count, medianMinutes}], prs: [{agent, records, reviewRoundsToClean, feedbackAfterClean, changesRequested, redCi}]}
 */
export function outcomes(state, { since, until, codexSince = {} }) {
  const jobs = new Map(), prs = new Map();
  for (const w of Object.values(state.work)) {
    let builtBy = null;
    for (const a of w.assignments || []) {
      // A history entry is the status being left, at the change: leaving queued is the start, the last entry the finish.
      const start = (a.history || []).find(h => h.status === 'queued')?.at || ((a.history || []).length ? a.at : null);
      if (!start || start < since || start >= until) continue;
      const agent = agentOf(state, w, a, start, codexSince);
      if (a.kind === 'implementation' && !builtBy) builtBy = agent;
      if (a.status !== 'done') continue;
      const k = `${agent}|${a.kind}`, end = a.history.at(-1).at;
      jobs.set(k, [...(jobs.get(k) || []), { mins: (Date.parse(end) - Date.parse(start)) / 60000, use: state.manifests?.[`usage:${w.id}/${a.id}`] }]);
    }
    if (!builtBy) continue;
    const reviews = w.reviews || [], clean = reviews.find(r => r.result === 'clean');
    const p = prs.get(builtBy) || { agent: builtBy, records: 0, rounds: [], feedbackAfterClean: 0, changesRequested: 0, redCi: 0 };
    p.records++;
    if (clean) p.rounds.push(reviews.filter(r => r.result === 'findings' && r.at < clean.at).length);
    if (clean && (w.findings || []).some(f => FEEDBACK.includes(f.source?.type) && f.source.at > clean.at)) p.feedbackAfterClean++;
    p.changesRequested += (w.findings || []).filter(f => f.source?.type === 'changes_requested').reduce((n, f) => n + (f.source.ids?.length || 1), 0);
    p.redCi += (w.findings || []).filter(f => f.source?.type === 'ci').length;
    prs.set(builtBy, p);
  }
  return {
    jobs: [...jobs].map(([k, js]) => {
      const [agent, kind] = k.split('|'), used = js.filter(j => j.use?.usage), priced = used.filter(j => j.use.cost != null);
      return { agent, kind, count: js.length, medianMinutes: median(js.map(j => j.mins)), withUsage: used.length, priced: priced.length,
        meanTokens: used.length ? Math.round(used.reduce((n, j) => n + sumTokens(j.use.usage), 0) / used.length) : null,
        meanCost: priced.length ? Math.round(priced.reduce((n, j) => n + j.use.cost, 0) / priced.length * 100) / 100 : null };
    })
      .sort((a, b) => b.count - a.count || a.agent.localeCompare(b.agent)),
    prs: [...prs.values()].map(({ rounds, ...p }) => ({ ...p, reviewRoundsToClean: mean(rounds) })).sort((a, b) => a.agent.localeCompare(b.agent)),
  };
}

export function outcomesMarkdown(r, cfg) {
  const { since, until } = cfg, n = x => Math.round(x).toLocaleString('en-US');
  const day = s => String(s).slice(0, 10);
  return [`# Factory outcomes by agent, ${day(since)} to ${day(until)}`, '',
    'From the factory\'s own records (W-558). A job\'s agent is its run manifest\'s, else its stream\'s on the day it started.', '',
    '## Jobs finished', '', '| Agent | Kind | Jobs | Median minutes, start to done | Jobs with token counts | Mean tokens per job | Mean cost per job |', '| --- | --- | --- | --- | --- | --- | --- |',
    ...r.jobs.map(j => `| ${j.agent} | ${j.kind} | ${j.count} | ${j.medianMinutes} | ${j.withUsage} | ${j.meanTokens == null ? 'none' : n(j.meanTokens)} | ${j.meanCost == null ? (j.withUsage ? 'tokens only (no price for its model)' : 'none') : `$${j.meanCost.toFixed(2)}${j.priced < j.withUsage ? ` (${j.priced} of ${j.withUsage} priced)` : ''}`} |`), '',
    ...(cfg.supervisorUsage?.length ? ['## Supervisor seats', '', 'Each seat\'s Claude sessions on this Mac over the week (a supervisor works several records at once, so this is per seat, not per job).', '',
      '| Seat | Sessions | Tokens | Cost |', '| --- | --- | --- | --- |', ...cfg.supervisorUsage.map(x => `| ${x.label} | ${x.sessions} | ${n(x.tokens)} | ${x.cost == null ? 'tokens only' : `$${x.cost.toFixed(2)}`} |`), ''] : []),
    '## PRs, by the agent that built them', '',
    '| Agent | Records | Internal review rounds before clean (mean) | Records with human feedback after our clean review | Changes-requested reviews | Red CI findings |', '| --- | --- | --- | --- | --- | --- |',
    ...r.prs.map(p => { const per = n => `${n} (${Math.round(n / p.records * 100)}%)`; return `| ${p.agent} | ${p.records} | ${p.reviewRoundsToClean ?? 'none clean yet'} | ${per(p.feedbackAfterClean)} | ${p.changesRequested} (${(p.changesRequested / p.records).toFixed(2)} per record) | ${p.redCi} (${(p.redCi / p.records).toFixed(2)} per record) |`; }), '',
    'Before 11-18 a Codex stream reviewed its own PRs, so Codex\'s review rounds measure Codex reviewing Codex (W-556 moved reviews to Claude).', '',
    '## Not measured', '',
    '- Tokens are read from each worker\'s session logs when its job finishes (W-561, from 11-18); jobs before that, host-stream workers and Codex supervisor seats have none. Cost is at Anthropic API rates for Claude; Codex shows tokens only.',
    '- Wall time includes time a job sat parked on a question.',
    '- Feedback after a clean review is not yet adjudicated as a real miss or not (the 26 escapes in the Phase 1 report).', ''].join('\n');
}

/** {stream: iso} for each stream config marks as Codex since a date (routing.supervisors.<label>.agentSince). */
export const codexSinceOf = config => Object.fromEntries(Object.entries(config.routing?.supervisors || {})
  .filter(([, s]) => s.agent === 'codex').map(([label, s]) => [label.replace(/^sup: /, ''), s.agentSince || '1970-01-01T00:00:00Z']));
