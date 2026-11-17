import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyRefs, pathHit, judgePrompt, parseJudge, combine, resultsReport, checkSheet, parseAnswers } from '../core/judge.mjs';

const H = c => c.repeat(40);
const CASE = { id: 'B-miss-W-1-aaaaaaa', kind: 'miss', title: 'Fix the export', repo: 'acme-org/app', pr: 'https://github.com/acme-org/app/pull/1', head: H('a'), base: H('0'),
  expected: [{ text: '1 new unresolved review thread(s): reviewer-sam https://github.com/acme-org/app/pull/1#discussion_r42', note: 'e8f4468: red-first with sam\'s repro', confirmedBy: 'e8f4468' }] };
const KEY = [{ ...CASE.expected[0], comments: [{ body: 'This crashes when the sheet is empty', path: 'app/exports/sheet.rb', line: 12 }], files: ['app/exports/sheet.rb', 'spec/exports/sheet_spec.rb'] }];
const run = (output, o = {}) => ({ dir: 'bench-B-miss-W-1-aaaaaaa-claude-1', case: CASE.id, agent: 'claude', n: 1, status: 'ok', durationMs: 120000, usage: '$1.00, 5 turns', output, ...o });
const said = (verdict, extras = []) => ({ expected: [{ i: 0, verdict, quote: '', reason: 'r' }], extras });

test("an answer-key item's GitHub refs are its linked comments and its fix commit", () => {
  assert.deepEqual(keyRefs(CASE.expected[0]), { comments: [{ repo: 'acme-org/app', pr: '1', kind: 'discussion_r', id: '42' }], fix: 'e8f4468' });
  assert.equal(keyRefs({ text: 'x', note: 'Fixed in a8bc536: wording', confirmedBy: 'fixed in a later round' }).fix, 'a8bc536');
  assert.equal(keyRefs({ text: 'Answered on Teamwork 41073672.' }).fix, null, 'a task id is not a commit');
});

test('the judge sees the answer key and the review, never which reviewer wrote it', () => {
  const p = judgePrompt(CASE, KEY, 'reviewed aaaa: 1 findings\n- app/exports/sheet.rb:12 nil when empty');
  assert.match(p, /This crashes when the sheet is empty/); assert.match(p, /The fix changed: app\/exports\/sheet\.rb/); assert.match(p, /nil when empty/);
  assert.doesNotMatch(p, /claude|codex/i);
});

test("a judge's reply is read from JSON even with prose around it, and refused when it isn't the shape", () => {
  assert.deepEqual(parseJudge('Here you go:\n```json\n{"expected":[{"i":0,"verdict":"found"}],"extras":[]}\n```'), { expected: [{ i: 0, verdict: 'found' }], extras: [] });
  assert.equal(parseJudge('I could not decide.'), null);
  assert.equal(parseJudge('{"verdict":"found"}'), null);
});

test('two agreeing judges settle a call; a split, an unusable judge, or "missed" while the review names the fix\'s file goes to a person', () => {
  const agree = (v, out = 'nothing relevant') => combine(KEY, run(out), { claude: said(v), codex: said(v) }).items[0].verdict;
  assert.equal(agree('found'), 'found');
  assert.equal(agree('missed'), 'missed');
  assert.equal(agree('missed', 'style nit in sheet.rb'), 'check', 'names the fixed file: a person looks');
  assert.equal(combine(KEY, run('x'), { claude: said('found'), codex: said('missed') }).items[0].verdict, 'check');
  assert.equal(combine(KEY, run('x'), { claude: said('found'), codex: null }).items[0].verdict, 'check');
  assert.equal(combine(KEY, run('x'), { claude: said('found'), codex: said('missed') }, { 'bench-B-miss-W-1-aaaaaaa-claude-1#0': 'no' }).items[0].verdict, 'missed', "the person's answer wins");
});

test('extra findings count as real or noise only where both judges say so', () => {
  const c = combine(KEY, run('x'), { claude: said('found', [{ verdict: 'likely-real' }, { verdict: 'likely-noise' }]), codex: said('found', [{ verdict: 'likely-real' }, { verdict: 'unsure' }]) });
  assert.deepEqual(c.extras, { real: 1, noise: 0, total: 2 });
});

test('the results page gives recall per reviewer, with unsettled calls shown apart rather than guessed', () => {
  const s = [combine(KEY, run('x'), { claude: said('found'), codex: said('found') }), combine(KEY, run('x', { n: 2, dir: 'd2' }), { claude: said('found'), codex: said('missed') })]
    .map((x, i) => ({ ...x, run: run('x', { n: i + 1 }) }));
  const md = resultsReport({ cases: [CASE] }, s);
  assert.match(md, /Recall, all known problems \| 100% \(1 found, 0 missed, 1 to check\)/);
  assert.match(md, /Bugs people found after our clean review \| 100%/);
  assert.match(md, /B-miss-W-1-aaaaaaa: claude 1\/2/);
});

test("the check sheet shows each unsettled call side by side, and a person's yes/no answers are read back", () => {
  const s = [{ ...combine(KEY, run('found the empty-sheet crash'), { claude: said('found'), codex: said('missed') }), run: run('found the empty-sheet crash') }];
  const md = checkSheet({ cases: [CASE] }, { [CASE.id]: KEY }, s);
  assert.match(md, /### bench-B-miss-W-1-aaaaaaa-claude-1#0/); assert.match(md, /This crashes when the sheet is empty/); assert.match(md, /Same problem\? ___/);
  assert.deepEqual(parseAnswers(md.replace('Same problem? ___', 'Same problem? Yes')), { 'bench-B-miss-W-1-aaaaaaa-claude-1#0': 'yes' });
  assert.deepEqual(parseAnswers(md), {});
  const answered = [{ ...combine(KEY, s[0].run, { claude: said('found'), codex: said('missed') }, { 'bench-B-miss-W-1-aaaaaaa-claude-1#0': 'yes' }), run: s[0].run }];
  assert.match(checkSheet({ cases: [CASE] }, { [CASE.id]: KEY }, answered), /Same problem\? yes/, 'a rewritten sheet keeps the answer');
});

// Alex 11-17: the judges' split calls are settled by location, mechanically, not by hand.
test("a fix commit's patch gives the line ranges it changed, on the code as reviewed", async () => {
  const { parseHunks } = await import('../core/judge.mjs');
  assert.deepEqual(parseHunks('app/x.rb', '@@ -10,4 +10,6 @@ def a\n-x\n+y\n@@ -40 +42,2 @@\n'), [{ file: 'app/x.rb', start: 10, end: 13 }, { file: 'app/x.rb', start: 40, end: 40 }]);
});

test('a split call is found when the review cites a line within 10 of what the fix changed or the person pointed at, else missed', async () => {
  const { locationCall, combine } = await import('../core/judge.mjs');
  const k = { ...KEY[0], hunks: [{ file: 'app/exports/sheet.rb', start: 30, end: 34 }] };
  assert.equal(locationCall(k, 'app/exports/sheet.rb:41 returns nil when the sheet is empty'), 'found', 'within 10 of the hunk');
  assert.equal(locationCall(k, '`sheet.rb:15` nil crash'), 'found', 'near the comment at line 12, by file name');
  assert.equal(locationCall(k, 'app/exports/sheet.rb:200 naming nit'), 'missed', 'same file, far away');
  assert.equal(locationCall(k, 'no line cited, but the empty sheet crashes'), 'missed', 'no citation: nothing to place');
  const c = combine([k], run('app/exports/sheet.rb:33 crash'), { claude: said('found'), codex: said('missed') }, {}, { settle: true }).items[0];
  assert.deepEqual([c.verdict, c.settledBy], ['found', 'location']);
  const agreed = combine([k], run('nothing here'), { claude: said('found'), codex: said('found') }, {}, { settle: true }).items[0];
  assert.deepEqual([agreed.verdict, agreed.settledBy], ['found', undefined], 'agreeing judges still decide');
});

test('the results say how many calls location settled', async () => {
  const { combine, resultsReport } = await import('../core/judge.mjs');
  const k = { ...KEY[0], hunks: [{ file: 'app/exports/sheet.rb', start: 30, end: 34 }] };
  const s = [{ ...combine([k], run('sheet.rb:31'), { claude: said('found'), codex: said('missed') }, {}, { settle: true }), run: run('sheet.rb:31') }];
  assert.match(resultsReport({ cases: [CASE] }, s), /1 call\(s\) the judges split were settled by location/);
});

test('a bare file name places a citation only when the fix changed one file of that name; a path must agree with it (W-408 READMEs)', async () => {
  const { locationCall } = await import('../core/judge.mjs');
  const k = { text: 'x', hunks: [{ file: 'kai/a/README.md', start: 8, end: 16 }, { file: 'kai/b/README.md', start: 23, end: 28 }] };
  assert.equal(locationCall(k, 'README.md:3 typo'), 'missed', 'two READMEs changed: a bare name could be either');
  assert.equal(locationCall(k, 'kai/a/README.md:12 wrong date'), 'found');
  assert.equal(locationCall(k, 'other/README.md:12 wrong date'), 'missed', 'a different README');
  assert.equal(locationCall({ text: 'x', hunks: [{ file: 'app/models/position.rb', start: 40, end: 44 }] }, 'position.rb:45 nil'), 'found', 'one file of that name');
});
