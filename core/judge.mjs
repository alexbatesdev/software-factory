// Scoring the review benchmark (Alex, 11-16): two judges from different model families grade each run against the case's
// answer key, a file check backs them up, and only the calls they don't agree on go to a person. Pure.

const SHA = /\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/;
const LINK = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)#(discussion_r|pullrequestreview-|issuecomment-)(\d+)/g;

/** What to read from GitHub to know an answer-key item: the people's comments it links, and the commit that fixed it. */
export function keyRefs(e) {
  const comments = [...String(e.text || '').matchAll(LINK)].map(([, repo, pr, kind, id]) => ({ repo, pr, kind, id }));
  const fix = SHA.test(e.confirmedBy || '') ? e.confirmedBy.match(SHA)[0] : String(e.note || '').match(SHA)?.[0] || null;
  return { comments, fix };
}

/** The review names a file the fix touched or the comment sits on. */
export const pathHit = (output, paths = []) => paths.some(p => p && (output.includes(p) || output.includes(p.split('/').at(-1))));

/** What the judge is shown: the answer key and the review, nothing about which reviewer wrote it. */
export function judgePrompt(c, key, output) {
  const items = key.map((k, i) => [`[${i}] ${k.text}`, k.note && `    Fix note: ${k.note}`, ...(k.comments || []).map(x => `    Reviewer's comment${x.path ? ` on ${x.path}${x.line ? `:${x.line}` : ''}` : ''}: ${x.body}`),
    k.files?.length && `    The fix changed: ${k.files.join(', ')}`].filter(Boolean).join('\n'));
  return [
    'You grade one code review against an answer key. Use no tools; judge from the text below. Be strict and literal.',
    `The change: ${c.title} (${c.repo} #${c.pr.split('/').pop()}, ${c.base.slice(0, 7)}..${c.head.slice(0, 7)}).`,
    '', 'ANSWER KEY: problems known to be in this change. Each was found later by a person or a later review, and fixed.',
    items.length ? items.join('\n') : '(none: the change merged with no known problems)',
    '', 'REVIEW TO GRADE:', '<<<', output || '(empty)', '>>>', '',
    'For each answer-key item: "found" if the review describes the same underlying problem (same cause, or same place and same consequence), even in other words. "missed" if it doesn\'t; naming the same file without the problem is missed. "unsure" if you can\'t tell.',
    'Then each finding in the review that matches no key item: "likely-real" if it shows concrete evidence of a real defect (a repro, a traced path, a cited line), "likely-noise" if it is style, speculation or wrong, "unsure" otherwise.',
    'Reply with only this JSON: {"expected":[{"i":0,"verdict":"found|missed|unsure","quote":"the review\'s words that match, or empty","reason":"one sentence"}],"extras":[{"quote":"short quote","verdict":"likely-real|likely-noise|unsure","reason":"one sentence"}]}',
  ].join('\n');
}

/** A judge's JSON reply, or null when it isn't usable. */
export function parseJudge(text) {
  const s = String(text || ''), a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { const j = JSON.parse(s.slice(a, b + 1)); return Array.isArray(j.expected) && Array.isArray(j.extras) ? j : null; } catch { return null; }
}

/**
 * Each key item is found or missed when both judges agree (missed also needs the review not to name the fix's files);
 * anything else, or a judge that gave no usable answer, goes to a person. A person's answer wins.
 * @param judges {name: parsed reply | null}  @param answers {"<run dir>#<i>": "yes"|"no"}
 */
/** The line ranges a fix's patch changed, on the old side (the code as it stood before the fix). */
export function parseHunks(file, patch) {
  return [...String(patch || '').matchAll(/^@@ -(\d+)(?:,(\d+))? \+/gm)].map(([, a, b]) => ({ file, start: Number(a), end: Number(a) + Math.max(Number(b ?? 1), 1) - 1 }));
}

const base = p => String(p).split('/').at(-1);
/**
 * Alex 11-17: a split call settled mechanically. Found when the review cites file:line within 10 lines of
 * a range the fix changed or of the line the person's comment sat on; missed otherwise, a review citing no line included.
 */
export function locationCall(k, output) {
  const cited = [...String(output || '').matchAll(/([\w./-]+\.[a-z]{1,5}):(\d+)/gi)].map(([, path, line]) => ({ path, line: Number(line) }));
  const anchors = [...(k.hunks || []), ...(k.comments || []).filter(c => c.path && c.line).map(c => ({ file: c.path, start: c.line, end: c.line }))];
  // A path must agree as a suffix; a bare name only places a citation when the fix changed one file of that name.
  const named = n => new Set(anchors.filter(a => base(a.file) === n).map(a => a.file)).size;
  const same = (a, c) => c.path.includes('/') ? a.file.endsWith(c.path) || c.path.endsWith(a.file) : base(a.file) === c.path && named(c.path) === 1;
  return cited.some(c => anchors.some(a => same(a, c) && c.line >= a.start - 10 && c.line <= a.end + 10)) ? 'found' : 'missed';
}

export function combine(key, run, judges, answers = {}, { settle = false } = {}) {
  const names = Object.keys(judges), ok = names.every(n => judges[n]);
  const items = key.map((k, i) => {
    const by = Object.fromEntries(names.map(n => [n, judges[n]?.expected.find(x => x.i === i) || null]));
    const votes = names.map(n => by[n]?.verdict), loc = pathHit(run.output || '', [...(k.files || []), ...(k.comments || []).map(x => x.path)]);
    const answer = answers[`${run.dir}#${i}`];
    const verdict = answer ? (answer === 'yes' ? 'found' : 'missed') : ok && votes.every(v => v === 'found') ? 'found' : ok && votes.every(v => v === 'missed') && !loc ? 'missed' : 'check';
    if (verdict === 'check' && settle) return { i, verdict: locationCall(k, run.output), settledBy: 'location', loc, by, answered: false };
    return { i, verdict, loc, by, answered: !!answer };
  });
  const extraVotes = names.map(n => judges[n]?.extras || []), tally = v => Math.min(...extraVotes.map(xs => xs.filter(x => x.verdict === v).length));
  return { items, extras: ok ? { real: tally('likely-real'), noise: tally('likely-noise'), total: Math.max(...extraVotes.map(xs => xs.length)) } : null };
}

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : 'n/a');
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/** The one-page result: recall, misses caught, estimated precision, noise on clean changes, time and cost, per reviewer. */
export function resultsReport(corpus, scored) {
  const byId = Object.fromEntries(corpus.cases.map(c => [c.id, c])), agents = [...new Set(scored.map(s => s.run.agent))].sort();
  const byLocation = scored.flatMap(s => s.items).filter(x => x.settledBy === 'location').length;
  const out = ['# Review benchmark: results', '', `${scored.length} runs judged. Recall counts only settled calls; "to check" calls wait on a person (check.md) and can move it either way.${byLocation ? ` ${byLocation} call(s) the judges split were settled by location (the review cites a line within 10 of what the fix changed or the person pointed at), not by a person.` : ''}`, '',
    '| | ' + agents.join(' | ') + ' |', '|---|' + agents.map(() => '---|').join('')];
  const row = (label, f) => out.push(`| ${label} | ${agents.map(a => f(scored.filter(s => s.run.agent === a))).join(' | ')} |`);
  const items = (ss, kind) => ss.filter(s => !kind || byId[s.run.case]?.kind === kind).flatMap(s => s.items);
  const recall = kind => ss => { const it = items(ss, kind), f = it.filter(x => x.verdict === 'found').length, m = it.filter(x => x.verdict === 'missed').length, c = it.length - f - m;
    return `${pct(f, f + m)} (${f} found, ${m} missed${c ? `, ${c} to check` : ''})`; };
  row('Recall, all known problems', recall());
  row('Bugs people found after our clean review', recall('miss'));
  row('Defects a later round fixed', recall('defect'));
  row('Extra findings per run', ss => (ss.filter(s => s.extras).reduce((n, s) => n + s.extras.total, 0) / Math.max(1, ss.filter(s => s.extras).length)).toFixed(1));
  row('Extras judged real (estimate)', ss => { const r = ss.reduce((n, s) => n + (s.extras?.real || 0), 0), z = ss.reduce((n, s) => n + (s.extras?.noise || 0), 0); return `${pct(r, r + z)} (${r} real, ${z} noise)`; });
  row('Findings per clean-change run', ss => { const c = ss.filter(s => byId[s.run.case]?.kind === 'clean' && s.extras); return c.length ? (c.reduce((n, s) => n + s.extras.total, 0) / c.length).toFixed(1) : 'n/a'; });
  row('Median run time', ss => `${Math.round(median(ss.map(s => s.run.durationMs || 0)) / 60000)}m`);
  row('Usage', ss => { const d = ss.map(s => Number(String(s.run.usage || '').match(/^\$([\d.]+)/)?.[1] || NaN)).filter(n => !Number.isNaN(n)); return d.length ? `$${d.reduce((a, b) => a + b, 0).toFixed(2)} total` : 'tokens: see each run'; });
  row('Runs that failed or timed out', ss => String(ss.filter(s => s.run.status !== 'ok').length));
  out.push('', '## Consistency: how many runs found each known problem', '');
  for (const c of corpus.cases.filter(c => c.expected.length && scored.some(s => s.run.case === c.id))) {
    out.push(`- ${c.id}: ${agents.map(a => { const ss = scored.filter(s => s.run.agent === a && s.run.case === c.id); return `${a} ${c.expected.map((_, i) => `${ss.filter(s => s.items[i]?.verdict === 'found').length}/${ss.length}`).join(' ')}`; }).join('; ')}`);
  }
  return out.join('\n') + '\n';
}

/** The calls the judges didn't settle, side by side, each with a blank for the person's answer. */
export function checkSheet(corpus, keys, scored) {
  const byId = Object.fromEntries(corpus.cases.map(c => [c.id, c]));
  const out = ['# Review benchmark: calls to check', '', 'For each one, read the known problem and the review, then write yes or no after "Same problem?". Then run `node bin/bench.mjs judge` again: it reads your answers and updates results.md.', ''];
  for (const s of scored) for (const it of s.items.filter(x => x.verdict === 'check' || x.answered)) {
    const k = keys[s.run.case][it.i], c = byId[s.run.case];
    out.push(`### ${s.run.dir}#${it.i}`, '', `${c.title} (${s.run.agent} run ${s.run.n})`, '', `**Known problem:** ${k.text}`, ...(k.note ? [`**How it was fixed:** ${k.note}`] : []),
      ...(k.comments || []).map(x => `**The person's comment:** ${x.body}`), '',
      `**Judges:** ${Object.entries(it.by).map(([n, v]) => `${n}: ${v ? `${v.verdict}, ${v.reason}${v.quote ? ` ("${v.quote}")` : ''}` : 'no usable answer'}`).join('; ')}${it.loc ? '. The review names a file the fix changed.' : ''}`, '',
      '<details><summary>The review</summary>', '', '~~~~', s.run.output || '(empty)', '~~~~', '', '</details>', '', `Same problem? ${it.answered ? (it.verdict === 'found' ? 'yes' : 'no') : '___'}`, '');
  }
  return out.join('\n');
}

/** A person's yes/no answers from a filled check sheet. */
export function parseAnswers(md) {
  const out = {};
  for (const block of String(md).split(/^### /m).slice(1)) {
    const id = block.split('\n')[0].trim(), a = block.match(/Same problem\?\s*(yes|no)\b/i)?.[1]?.toLowerCase();
    if (a) out[id] = a;
  }
  return out;
}
