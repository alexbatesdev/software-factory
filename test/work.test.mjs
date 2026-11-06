import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWork, applyEvent, updateWork, gate, migrate, syncIntake, observeHead, unverifyHead, prReadyPreflight, observeHealth } from '../core/work.mjs';

const T = '2026-10-26T15:00:00.000Z';
const ctx = (over = {}) => ({ now: T, by: 'test', openQuestions: 0, ...over });
const build = (over = {}) => createWork({ id: 'W-1', title: 'Fix the thing', kind: 'build', criteria: ['Thing is fixed'], ...over }, ctx());
const run = (w, ...events) => events.reduce((acc, e) => applyEvent(acc, e, ctx(e.ctx)).work, w);

test('manual intake creates an intake item with a stable id, criteria and default priority', () => {
  const w = build();
  assert.equal(w.id, 'W-1');
  assert.equal(w.phase, 'intake');
  assert.equal(w.priority, 3);
  assert.deepEqual(w.criteria.map(c => c.text), ['Thing is fixed']);
  assert.equal(w.criteria[0].acceptedHead, null);
});

test('ready is refused while the item has open questions', () => {
  assert.throws(() => applyEvent(build(), { type: 'transition', to: 'ready' }, ctx({ openQuestions: 1 })), /open question/);
  assert.equal(applyEvent(build(), { type: 'transition', to: 'ready' }, ctx()).work.phase, 'ready');
});

test('a generic update cannot move the phase or touch evidence', () => {
  assert.throws(() => updateWork(build(), { phase: 'ready_for_human' }, ctx()), /phase/);
  assert.throws(() => updateWork(build(), { reviews: [] }, ctx()), /reviews/);
  const w = updateWork(build(), { priority: 1, addCriteria: ['Spec pins it'] }, ctx());
  assert.equal(w.priority, 1);
  assert.equal(w.criteria.length, 2);
});

const toImplementation = () => run(build(), { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' },
  { type: 'transition', to: 'implementation', owner: 'sbx: stream-1' });

test('worker done only requests review', () => {
  const w = run(toImplementation(), { type: 'implementation_done', head: 'aaa' });
  assert.equal(w.phase, 'review');
  assert.equal(w.head, 'aaa');
  assert.ok(w.requests.some(r => r.type === 'review' && r.delivery === 'pending'));
  assert.throws(() => applyEvent(w, { type: 'mark_ready' }, ctx()), /review/);
});

test('review by the implementer is not independent', () => {
  const w = run(toImplementation(), { type: 'implementation_done', head: 'aaa' });
  assert.throws(() => applyEvent(w, { type: 'review', head: 'aaa', by: 'sbx: stream-1', result: 'clean' }, ctx()), /independent/);
});

test('review at a stale head is refused', () => {
  const w = run(toImplementation(), { type: 'implementation_done', head: 'aaa' });
  assert.throws(() => applyEvent(w, { type: 'review', head: 'old', by: 'reviewer', result: 'clean' }, ctx()), /head/);
});

test('findings -> fixes -> a clean re-review is ready for human, with no checks or criteria recorded', () => {
  let w = run(toImplementation(), { type: 'implementation_done', head: 'aaa' },
    { type: 'review', head: 'aaa', by: 'reviewer', result: 'findings', findings: [{ text: 'missing nil guard', severity: 'P2' }] });
  assert.equal(w.phase, 'fixes');
  const fid = w.findings[0].id;
  w = run(w, { type: 'finding', findingId: fid, status: 'resolved', note: 'guarded in bbb' },
    { type: 'implementation_done', head: 'bbb' });
  assert.equal(w.phase, 'rereview');
  w = run(w, { type: 'review', head: 'bbb', by: 'reviewer', result: 'clean' });
  assert.deepEqual(gate(w), { ok: true, reasons: [] });
  assert.equal(w.phase, 'ready_for_human');
});

test('an accepted finding needs a note', () => {
  const w = run(toImplementation(), { type: 'implementation_done', head: 'aaa' },
    { type: 'review', head: 'aaa', by: 'reviewer', result: 'findings', findings: [{ text: 'nit' }] });
  assert.throws(() => applyEvent(w, { type: 'finding', findingId: w.findings[0].id, status: 'accepted' }, ctx()), /note/);
});

test('a later commit invalidates the review and readiness', () => {
  let w = run(toImplementation(), { type: 'implementation_done', head: 'aaa' },
    { type: 'review', head: 'aaa', by: 'reviewer', result: 'clean' },
    { type: 'check', name: 'rspec', head: 'aaa', result: 'pass' });
  w = run(w, { type: 'criterion', criterionId: w.criteria[0].id, accepted: true, head: 'aaa' }, { type: 'mark_ready' });
  assert.equal(w.phase, 'ready_for_human');
  w = run(w, { type: 'head', sha: 'ccc' });
  assert.equal(w.phase, 'rereview');
  const g = gate(w);
  assert.equal(g.ok, false);
  assert.match(g.reasons.join(' '), /review at ccc/);
});

test('non-PR work completes with an accepted artifact, without a head', () => {
  let w = createWork({ id: 'W-2', title: 'Research ATS ACs', kind: 'research', criteria: ['Findings cite tasks'] }, ctx());
  w = run(w, { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' }, { type: 'transition', to: 'implementation', owner: 'sup: stream-2' });
  assert.throws(() => applyEvent(w, { type: 'complete', artifact: '/tmp/x.md' }, ctx()), /criteri/);
  w = run(w, { type: 'criterion', criterionId: w.criteria[0].id, accepted: true });
  w = run(w, { type: 'complete', artifact: '/Users/alex.bates/Code/plans/ats.md' });
  assert.equal(w.phase, 'done');
  assert.equal(w.completion.artifact, '/Users/alex.bates/Code/plans/ats.md');
});

test('out-of-scope discovery spawns a proposed item; in-scope stays on the item', () => {
  const w = toImplementation();
  const a = applyEvent(w, { type: 'discovery', text: 'seeds are slow', inScope: false }, ctx());
  assert.equal(a.spawn.phase, 'proposed');
  assert.equal(a.spawn.proposedFrom, 'W-1');
  const b = applyEvent(w, { type: 'discovery', text: 'nil guard missing here', inScope: true }, ctx());
  assert.equal(b.spawn, undefined);
  assert.equal(b.work.findings.at(-1).text, 'nil guard missing here');
});

test('pause and cancel are requests whose delivery and ack are tracked separately', () => {
  let w = toImplementation();
  w = run(w, { type: 'request', request: 'cancel' });
  const r = w.requests.at(-1);
  assert.equal(r.delivery, 'pending');
  assert.equal(w.phase, 'implementation', 'a request alone changes nothing');
  w = run(w, { type: 'delivery', requestId: r.id, status: 'failed', detail: 'pane gone' });
  assert.equal(w.requests.at(-1).delivery, 'failed');
  assert.equal(w.phase, 'implementation');
  w = run(w, { type: 'ack', requestId: r.id, by: 'code-e1', outcome: 'done' });
  assert.equal(w.phase, 'cancelled');
});

test('intake phase follows triage until the item is queued', () => {
  let w = build();
  w = syncIntake(w, { bucket: 'clarify', openQuestions: 2 });
  assert.equal(w.phase, 'clarification');
  w = syncIntake(w, { bucket: 'clarify', openQuestions: 0 });
  assert.equal(w.phase, 'ready');
  w = run(w, { type: 'transition', to: 'queued' });
  assert.equal(syncIntake(w, { bucket: 'rewrite', openQuestions: 0 }).phase, 'queued');
});

test('migration is additive: keeps every question, links them, and is idempotent', () => {
  const old = {
    items: { 'tw-1': { firstSeen: T, triage: { bucket: 'clarify' } }, 'built-rails-7': { firstSeen: T } },
    questions: { 'TB-1': { item: 'tw-1', status: 'open', title: 'q' }, 'TB-2': { from: 'sup: x', status: 'answered', title: 'p' } },
    nextQuestion: 45, streams: {}, dispatches: [],
  };
  const s = migrate(structuredClone(old), T);
  assert.equal(s.schema, 2);
  assert.equal(Object.keys(s.work).length, 2);
  assert.equal(s.nextQuestion, 45);
  assert.deepEqual(Object.keys(s.questions), ['TB-1', 'TB-2']);
  assert.equal(s.questions['TB-1'].work, s.workBySource['tw-1']);
  assert.equal(s.questions['TB-2'].status, 'answered');
  const again = migrate(structuredClone(s), T);
  assert.deepEqual(again, s);
  assert.deepEqual(JSON.parse(JSON.stringify(again)), again, 'survives a save and reload');
});

// Regressions from Dot's adversarial review (spamton-dashboard-adversarial.mjs), plus check coverage and dependencies.
const reviewing = () => run(toImplementation(), { type: 'implementation_done', head: 'aaa' });
const evidenced = w => run(w, { type: 'check', name: 'suite', head: w.head, result: 'pass' }, { type: 'criterion', criterionId: 'C1', accepted: true, head: w.head });
const readyAt = () => run(evidenced(run(reviewing(), { type: 'review', head: 'aaa', by: 'reviewer', result: 'clean' })), { type: 'mark_ready' });

test('a resolved finding cannot skip re-review', () => {
  let w = run(reviewing(), { type: 'review', head: 'aaa', by: 'reviewer', result: 'findings', findings: [{ text: 'bug' }] });
  w = evidenced(run(w, { type: 'finding', findingId: 'F1', status: 'resolved', note: 'fixed' }));
  assert.throws(() => applyEvent(w, { type: 'mark_ready' }, ctx()), /review/);
});

test('an open question or unfinished dependency blocks readiness', () => {
  const w = applyEvent(reviewing(), { type: 'review', head: 'aaa', by: 'reviewer', result: 'clean' }, ctx({ openQuestions: 1 })).work;
  assert.equal(w.phase, 'review', 'a clean review with a question open stays in review');
  assert.throws(() => applyEvent(w, { type: 'mark_ready' }, ctx({ openQuestions: 1 })), /question/);
  assert.throws(() => applyEvent(w, { type: 'mark_ready' }, ctx({ openDeps: ['W-9'] })), /W-9/);
});

test('a failing check takes away the ready label', () => {
  assert.notEqual(run(readyAt(), { type: 'check', head: 'aaa', name: 'suite', result: 'fail' }).phase, 'ready_for_human');
});

test('started build work cannot change kind to escape review', () => {
  assert.throws(() => updateWork(reviewing(), { kind: 'research' }, ctx()), /kind/);
  assert.equal(updateWork(build(), { kind: 'research' }, ctx()).kind, 'research');
});

test('review findings raise a fixes request', () => {
  const w = run(reviewing(), { type: 'review', head: 'aaa', by: 'reviewer', result: 'findings', findings: [{ text: 'bug' }] });
  assert.ok(w.requests.some(r => r.type === 'fixes' && r.delivery === 'pending'));
});

test('every required check must pass at the current head', () => {
  let w = updateWork(build(), { requiredChecks: ['rspec', 'jest'] }, ctx());
  w = run(w, { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' }, { type: 'transition', to: 'implementation', owner: 'sbx: s' },
    { type: 'implementation_done', head: 'aaa' }, { type: 'review', head: 'aaa', by: 'reviewer', result: 'clean' },
    { type: 'check', name: 'rspec', head: 'aaa', result: 'pass' }, { type: 'criterion', criterionId: 'C1', accepted: true, head: 'aaa' });
  assert.match(gate(w).reasons.join(' '), /jest/);
  w = run(w, { type: 'check', name: 'jest', head: 'aaa', result: 'pass' });
  assert.equal(gate(w).ok, true);
});

test('unfinished dependencies block queueing and starting', () => {
  const w = run(build(), { type: 'transition', to: 'ready' });
  assert.throws(() => applyEvent(w, { type: 'transition', to: 'queued' }, ctx({ openDeps: ['W-9'] })), /W-9/);
  const q = run(w, { type: 'transition', to: 'queued' });
  assert.throws(() => applyEvent(q, { type: 'transition', to: 'implementation' }, ctx({ openDeps: ['W-9'] })), /W-9/);
});

test('a PR-linked item needs a verified current head before ready', () => {
  let w = run(updateWork(build(), { links: { pr: 'https://github.com/builtforteams/built-rails/pull/1' } }, ctx()),
    { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' }, { type: 'transition', to: 'implementation', owner: 'sbx: s' },
    { type: 'implementation_done', head: 'aaa' });
  w = evidenced(run(w, { type: 'review', head: 'aaa', by: 'reviewer', result: 'clean' }));
  assert.equal(gate(w).ok, true, 'the worker reported the head itself');
  w = observeHead(w, { sha: 'aaa', via: 'github' }, ctx());
  w = unverifyHead(w, ctx());
  assert.match(gate(w).reasons.join(' '), /not verified/, 'GitHub stopped seeing the PR');
  w = run(w, { type: 'head', sha: 'aaa' });
  assert.equal(gate(w).ok, true, 'an explicit head report verifies it again');
  w = run(w, { type: 'mark_ready' });
  w = observeHead(w, { sha: 'ddd', via: 'github' }, ctx());
  assert.equal(w.phase, 'rereview', 'a commit seen on GitHub invalidates readiness');
  assert.equal(w.head, 'ddd');
});

// ---------- automation slice ----------
test('queueing creates the dispatch request; asking again is idempotent', () => {
  let w = run(build(), { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' });
  assert.deepEqual(w.requests.map(r => [r.type, r.delivery]), [['dispatch', 'pending']]);
  w = run(w, { type: 'request', request: 'dispatch' });
  assert.equal(w.requests.filter(r => r.type === 'dispatch').length, 1);
});

const PR = 'https://github.com/builtforteams/built-rails/pull/77';
const readyPr = () => {
  let w = run(updateWork(build(), { links: { pr: PR } }, ctx()), { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' },
    { type: 'transition', to: 'implementation', owner: 'sbx: s' }, { type: 'implementation_done', head: 'aaa' });
  return run(evidenced(run(w, { type: 'review', head: 'aaa', by: 'reviewer', result: 'clean' })), { type: 'mark_ready' });
};

test('PR-ready authorization is pinned to the PR and the exact head, and a new head drops it', () => {
  assert.throws(() => applyEvent(readyPr(), { type: 'authorize_pr_ready', prUrl: PR, head: 'zzz' }, ctx()), /head/);
  assert.throws(() => applyEvent(readyPr(), { type: 'authorize_pr_ready', prUrl: 'https://github.com/builtforteams/built-rails/pull/78', head: 'aaa' }, ctx()), /PR/);
  let w = run(readyPr(), { type: 'authorize_pr_ready', prUrl: PR, head: 'aaa' });
  assert.equal(w.prReadyAuth.head, 'aaa');
  w = observeHead(w, { sha: 'bbb', via: 'github' }, ctx());
  assert.equal(w.prReadyAuth, null);
});

test('PR-ready preflight needs ready phase, gate, authorization and a fresh matching remote head', () => {
  const w = run(readyPr(), { type: 'authorize_pr_ready', prUrl: PR, head: 'aaa' });
  assert.deepEqual(prReadyPreflight(w, { head: 'aaa', isDraft: true }, ctx()), []);
  assert.match(prReadyPreflight(w, { head: 'ccc', isDraft: true }, ctx()).join(' '), /GitHub shows ccc/);
  assert.match(prReadyPreflight(w, null, ctx()).join(' '), /read/);
  assert.match(prReadyPreflight(readyPr(), { head: 'aaa', isDraft: true }, ctx()).join(' '), /authoriz/);
  assert.match(prReadyPreflight(w, { head: 'aaa', isDraft: true }, ctx({ openQuestions: 1 })).join(' '), /question/);
});

test('migration gives existing work records the automation fields without touching the rest', () => {
  const legacy = { id: 'W-5', title: 'old', kind: 'build', phase: 'intake', criteria: [], requests: [], updates: [], findings: [], reviews: [], checks: [] };
  const s = migrate({ items: {}, questions: {}, work: { 'W-5': structuredClone(legacy) }, workBySource: {}, nextWork: 6, schema: 2 }, T);
  const w = s.work['W-5'];
  assert.deepEqual(w.prReadyOps, []);
  assert.equal(w.prReadyAuth, null);
  assert.equal(w.headVerified, null);
  assert.deepEqual(w.requiredChecks, []);
  assert.equal(w.title, 'old');
});

// ---------- reality correction ----------
test('reconcile records what is already happening, with evidence and no request', () => {
  const w = run(build(), { type: 'reconcile', phase: 'implementation', owner: 'sup-stream-conf-stack', evidence: 'triage-2026-10-27-R2-brief.md' });
  assert.equal(w.phase, 'implementation');
  assert.equal(w.owner, 'sup-stream-conf-stack');
  assert.equal(w.requests.length, 0, 'no dispatch request, so no notice');
  assert.equal(w.reconciled.evidence, 'triage-2026-10-27-R2-brief.md');
  assert.throws(() => applyEvent(build(), { type: 'reconcile', phase: 'implementation', owner: 'x' }, ctx()), /evidence/);
  assert.throws(() => applyEvent(build(), { type: 'reconcile', phase: 'ready_for_human', evidence: 'x' }, ctx()), /reconcile/);
});

test('reconciling to review keeps the head but grants no review evidence', () => {
  const w = run(build(), { type: 'reconcile', phase: 'review', head: '76fa170cb90', evidence: 'Stream 1 report' });
  assert.equal(w.phase, 'review');
  assert.equal(w.head, '76fa170cb90');
  assert.equal(w.reviews.length, 0);
  assert.equal(w.requests.length, 0);
  assert.equal(gate(w).ok, false);
});

test('an external dependency is a wait, not a question, and blocks the start', () => {
  let w = updateWork(build(), { externalDeps: [{ ref: 'built-rails#8050', text: '#8050 merges, then "go build" from the head' }] }, ctx());
  w = run(w, { type: 'reconcile', phase: 'queued', evidence: 'head evidence D1' });
  assert.throws(() => applyEvent(w, { type: 'transition', to: 'implementation' }, ctx()), /#8050/);
  assert.equal(syncIntake(run(build(), { type: 'reconcile', phase: 'ready', evidence: 'x' }), { bucket: 'clarify', openQuestions: 3 }).phase, 'ready', 'triage does not override a reconciled phase');
});

test('migration marks questions verified or unverified without touching their content', () => {
  const s = migrate({ items: {}, work: {}, questions: { 'TB-1': { status: 'open', title: 'auto' }, 'TB-2': { status: 'open', title: 'agent', source: 'inbox' }, 'TB-3': { status: 'answered', title: 'done', answer: { choice: 'a' } } } }, T);
  assert.deepEqual(['TB-1', 'TB-2', 'TB-3'].map(k => s.questions[k].verification), ['unverified', 'verified', 'unverified']);
  assert.deepEqual(s.questions['TB-3'].answer, { choice: 'a' });
  assert.equal(s.questions['TB-1'].status, 'open');
});

test('a reconcile report cannot overwrite a head GitHub verified', () => {
  let w = observeHead(build(), { sha: 'new111', via: 'github' }, ctx());
  w = run(w, { type: 'reconcile', phase: 'implementation', head: 'old000', evidence: 'stale report' });
  assert.equal(w.head, 'new111');
});

test('a links update merges; null removes one link; nothing else is lost', () => {
  let w = updateWork(build(), { links: { source: 'https://tw/1', artifact: '/tmp/a.md' } }, ctx());
  w = updateWork(w, { links: { pr: 'https://github.com/builtforteams/built-rails/pull/1' } }, ctx());
  assert.deepEqual(Object.keys(w.links).sort(), ['artifact', 'pr', 'source']);
  w = updateWork(w, { links: { artifact: null } }, ctx());
  assert.deepEqual(Object.keys(w.links).sort(), ['pr', 'source']);
});

test('a stale completion report never rolls back a GitHub-observed head and is flagged', () => {
  let w = run(toImplementation());
  w = observeHead(w, { sha: 'new111', via: 'github' }, ctx());
  w = run(w, { type: 'implementation_done', head: 'old000' });
  assert.equal(w.head, 'new111');
  assert.equal(w.staleReports.at(-1).reported, 'old000');
  assert.equal(w.requests.at(-1).head, 'new111', 'review is requested for what GitHub shows');
});

test('a short SHA matches the full head it abbreviates', () => {
  const full = '76fa170cb90116df362da8b931fff9d4bc736f48';
  let w = observeHead(run(toImplementation()), { sha: full, via: 'github' }, ctx());
  w = run(w, { type: 'implementation_done', head: '76fa170cb90' });
  assert.equal(w.head, full);
  assert.equal(w.staleReports, undefined, 'not flagged stale');
  w = run(w, { type: 'review', head: '76fa170', by: 'reviewer', result: 'clean' });
  assert.equal(w.reviews.at(-1).head, full);
});

// ---------- historical (retrospective) reconciliation ----------
const merged = n => ({ url: `https://github.com/builtforteams/built-rails/pull/${n}`, state: 'MERGED', head: `h${n}`, mergedAt: '2026-10-20T00:00:00Z' });
const opened = n => ({ url: `https://github.com/builtforteams/built-rails/pull/${n}`, state: 'OPEN', head: `h${n}`, isDraft: false });

test('retro completed needs full coverage and every cited PR merged, and fakes no evidence', () => {
  const w = run(build(), { type: 'retro_close', outcome: 'completed', coverage: 'full', prs: [merged(1), merged(2)], evidence: 'Sync comment 123: PR #1 merged', ctx: { verifiedPrs: [merged(1), merged(2)] } });
  assert.equal(w.phase, 'done');
  assert.deepEqual([w.retro.outcome, w.retro.coverage, w.retro.prs.length], ['completed', 'full', 2]);
  assert.deepEqual([w.reviews.length, w.checks.length, w.criteria.some(c => c.accepted)], [0, 0, false], 'no review, check or acceptance invented');
  assert.equal(w.prReadyOps.length, 0);
});

test('partial coverage, an open PR, or an unverified PR state is refused as completed', () => {
  assert.throws(() => applyEvent(build(), { type: 'retro_close', outcome: 'completed', coverage: 'partial', prs: [merged(1)], evidence: 'x' }, ctx({ verifiedPrs: [merged(1)] })), /full coverage/);
  assert.throws(() => applyEvent(build(), { type: 'retro_close', outcome: 'completed', coverage: 'full', prs: [merged(1), opened(2)], evidence: 'x' }, ctx({ verifiedPrs: [merged(1), opened(2)] })), /#2 is OPEN/);
  assert.throws(() => applyEvent(build(), { type: 'retro_close', outcome: 'completed', coverage: 'full', prs: [merged(1)], evidence: 'x' }, ctx({ verifiedPrs: [] })), /verified/);
});

test('superseded and duplicate name their target; an open PR records coverage without closing', () => {
  assert.throws(() => applyEvent(build(), { type: 'retro_close', outcome: 'duplicate', evidence: 'x' }, ctx()), /target/);
  assert.equal(run(build(), { type: 'retro_close', outcome: 'duplicate', target: 'W-9', evidence: 'same TW' }).retro.target, 'W-9');
  const w = run(build(), { type: 'coverage', state: 'open-pr', prs: [opened(5)], evidence: 'Sync comment: PR #5 opened', ctx: { verifiedPrs: [opened(5)] } });
  assert.deepEqual([w.phase, w.coverage.state, w.owner], ['intake', 'open-pr', null], 'not done, no worker assumed');
  const p = run(build(), { type: 'coverage', state: 'partial', prs: [merged(6)], missing: 'subtask 2 not covered', evidence: 'x' });
  assert.equal(p.coverage.missing, 'subtask 2 not covered');
});

test('retro close refuses active, owned or requested work at the model, whatever the route checked earlier', () => {
  const act = run(build(), { type: 'reconcile', phase: 'implementation', owner: 'sup: x', evidence: 'x' });
  assert.throws(() => applyEvent(act, { type: 'retro_close', outcome: 'duplicate', target: 'W-9', evidence: 'x' }, ctx()), /active|assigned/);
  const owned = updateWork(build(), { owner: 'sup: x' }, ctx());
  assert.throws(() => applyEvent(owned, { type: 'retro_close', outcome: 'duplicate', target: 'W-9', evidence: 'x' }, ctx()), /assigned/);
  const req = run(build(), { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' });
  assert.throws(() => applyEvent(req, { type: 'retro_close', outcome: 'duplicate', target: 'W-9', evidence: 'x' }, ctx()), /active|request/);
});

test('work an open PR carries, or whose coverage is unknown, cannot be marked ready or queued; partial or none is known work left to build', () => {
  for (const state of ['open-pr', 'unknown']) {
    const w = run(build(), { type: 'coverage', state, evidence: 'matrix', ctx: { verifiedPrs: [{ url: 'u', state: 'OPEN' }] } });
    assert.throws(() => applyEvent(w, { type: 'transition', to: 'ready' }, ctx()), /coverage/, state);
  }
  for (const state of ['partial', 'none']) {
    const w = run(build(), { type: 'coverage', state, evidence: 'matrix', missing: 'the send' });
    assert.equal(run(w, { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' }).phase, 'queued', state);
    assert.equal(syncIntake(w, { bucket: 'ready', openQuestions: 0 }).phase, 'ready', `${state}: triage lifts it like any other work`);
  }
  const readyThenCovered = run(build(), { type: 'transition', to: 'ready' }, { type: 'coverage', state: 'open-pr', evidence: 'x', ctx: { verifiedPrs: [{ url: 'u', state: 'OPEN' }] } });
  assert.throws(() => applyEvent(readyThenCovered, { type: 'transition', to: 'queued' }, ctx()), /coverage/);
  assert.equal(syncIntake(run(build(), { type: 'coverage', state: 'unknown', evidence: 'x' }), { bucket: 'ready', openQuestions: 0 }).phase, 'intake', 'triage does not lift it to ready');
});

test('open-pr coverage needs a PR that is open now; mixed states are fine if one is', () => {
  const pr = (n, state) => ({ url: `https://github.com/builtforteams/built-rails/pull/${n}`, state });
  assert.throws(() => applyEvent(build(), { type: 'coverage', state: 'open-pr', prs: [pr(1, 'MERGED'), pr(2, 'CLOSED')], evidence: 'x' }, ctx({ verifiedPrs: [pr(1, 'MERGED'), pr(2, 'CLOSED')] })), /open now/);
  assert.throws(() => applyEvent(build(), { type: 'coverage', state: 'open-pr', prs: [pr(3, 'UNREADABLE')], evidence: 'x' }, ctx({ verifiedPrs: [] })), /open now/);
  const w = run(build(), { type: 'coverage', state: 'open-pr', prs: [pr(4, 'MERGED'), pr(5, 'OPEN')], evidence: 'x', ctx: { verifiedPrs: [pr(4, 'MERGED'), pr(5, 'OPEN')] } });
  assert.equal(w.coverage.state, 'open-pr');
});

// ---------- structured assignments ----------
const inReview = () => { const w = run(toImplementation(), { type: 'implementation_done', head: 'ce77' }); return run(w, { type: 'ack', requestId: w.requests.find(r => r.type === 'review').id, by: 'code-e1', outcome: 'received' }); };

test('a started fixes assignment moves review to fixes and keeps the review request history', () => {
  const before = inReview();
  const w = run(before, { type: 'assign', assignmentId: 'R3', kind: 'fixes', owner: 'sup: stream-conf-stack', status: 'started', evidence: 'head evidence', brief: 'b.md' });
  assert.equal(w.phase, 'fixes');
  assert.equal(w.owner, 'sup: stream-conf-stack');
  assert.deepEqual(w.assignments.map(a => [a.id, a.status, a.version]), [['R3', 'started', 1]]);
  assert.equal(w.requests.find(r => r.type === 'review').ack.outcome, 'received', 'review request history kept');
  assert.equal(w.requests.length, before.requests.length, 'no new request');
});

test('a queued assignment queues without a request, and cannot start before its dependency', () => {
  const w = run(build(), { type: 'assign', assignmentId: 'R4', kind: 'fixes', owner: 'sup: stream-1 (support+sec)', status: 'queued', dependsOn: ['W-76'], evidence: 'x' });
  assert.equal(w.phase, 'queued');
  assert.equal(w.requests.length, 0);
  assert.throws(() => applyEvent(w, { type: 'progress', assignmentId: 'R4', expectedVersion: 1, stage: 'started' }, ctx({ openDeps: ['W-76'] })), /W-76/);
  const s = run(w, { type: 'progress', assignmentId: 'R4', expectedVersion: 1, stage: 'started' });
  assert.deepEqual([s.phase, s.assignments[0].status, s.assignments[0].version], ['fixes', 'started', 2]);
});

test('stale or non-current assignment reports are rejected, never applied', () => {
  let w = run(inReview(), { type: 'assign', assignmentId: 'R3', kind: 'fixes', owner: 'sup: x', status: 'started', evidence: 'x' });
  assert.throws(() => applyEvent(w, { type: 'progress', assignmentId: 'R3', expectedVersion: 0, stage: 'working' }, ctx()), /version/);
  assert.throws(() => applyEvent(w, { type: 'progress', assignmentId: 'R2', expectedVersion: 1, stage: 'working' }, ctx()), /current/);
  assert.throws(() => applyEvent(w, { type: 'assign', assignmentId: 'R3', kind: 'fixes', owner: 'sup: x', status: 'started', evidence: 'x' }, ctx()), /already/);
});

test('done on an assignment requests review once; a second done is a no-op', () => {
  let w = run(inReview(), { type: 'assign', assignmentId: 'R3', kind: 'fixes', owner: 'sup: x', status: 'started', evidence: 'x' });
  w = run(w, { type: 'assignment_done', assignmentId: 'R3', expectedVersion: 1, head: 'dd11' });
  assert.equal(w.phase, 'rereview');
  assert.equal(w.requests.filter(r => r.type === 'review').length, 2, 'one new review request for the fix round');
  assert.throws(() => applyEvent(w, { type: 'assignment_done', assignmentId: 'R3', expectedVersion: 2, head: 'dd11' }, ctx()), /done/);
  assert.equal(gate(w).ok, false, 'no review recorded at dd11: the gate still holds');
});

test('a direct started assign checks its own new dependencies; an unknown dependency never allows a start', () => {
  const ev = { type: 'assign', assignmentId: 'R4', kind: 'fixes', owner: 'sup: x', status: 'started', dependsOn: ['W-76'], evidence: 'x' };
  assert.throws(() => applyEvent(build(), ev, ctx({ depPhase: d => (d === 'W-76' ? 'implementation' : undefined) })), /W-76/);
  assert.throws(() => applyEvent(build(), ev, ctx({ depPhase: () => undefined })), /W-76/);
  assert.equal(applyEvent(build(), ev, ctx({ depPhase: () => 'ready_for_human' })).work.phase, 'fixes');
});

test('working needs a started assignment; queued or blocked work restarts through started', () => {
  const q = run(build(), { type: 'assign', assignmentId: 'R4', kind: 'fixes', owner: 'sup: x', status: 'queued', evidence: 'x' });
  assert.throws(() => applyEvent(q, { type: 'progress', assignmentId: 'R4', expectedVersion: 1, stage: 'working' }, ctx()), /queued/);
  const b = run(q, { type: 'progress', assignmentId: 'R4', expectedVersion: 1, stage: 'started' }, { type: 'progress', assignmentId: 'R4', expectedVersion: 2, stage: 'blocked' });
  assert.throws(() => applyEvent(b, { type: 'progress', assignmentId: 'R4', expectedVersion: 3, stage: 'working' }, ctx()), /blocked/);
  const s = run(b, { type: 'progress', assignmentId: 'R4', expectedVersion: 3, stage: 'started' }, { type: 'progress', assignmentId: 'R4', expectedVersion: 4, stage: 'working' });
  assert.deepEqual([s.assignments[0].status, s.assignments[0].version], ['started', 5]);
});

test('a new assignment replaces the current one only when it names it at its version', () => {
  const w = run(inReview(), { type: 'assign', assignmentId: 'R3', kind: 'fixes', owner: 'sup: x', status: 'started', evidence: 'x' });
  const next = { type: 'assign', assignmentId: 'R5', kind: 'fixes', owner: 'sup: x', status: 'queued', evidence: 'y' };
  assert.throws(() => applyEvent(w, next, ctx()), /R3/);
  assert.throws(() => applyEvent(w, { ...next, supersedes: 'R3', expectedVersion: 0 }, ctx()), /version/);
  const s = run(w, { ...next, supersedes: 'R3', expectedVersion: 1 });
  assert.deepEqual(s.assignments.map(a => [a.id, a.status]), [['R3', 'superseded'], ['R5', 'queued']]);
  assert.ok(s.assignments[0].history.length, 'old assignment history kept');
});

test('reconcile and legacy done cannot move work that has a current assignment', () => {
  const w = run(toImplementation(), { type: 'assign', assignmentId: 'R1', kind: 'implementation', owner: 'sup: x', status: 'started', evidence: 'x' });
  assert.throws(() => applyEvent(w, { type: 'reconcile', phase: 'review', evidence: 'x' }, ctx()), /R1/);
  assert.throws(() => applyEvent(w, { type: 'implementation_done', head: 'aa11bb22' }, ctx()), /R1/);
});

test('assignment done is checked against the fresh GitHub head', () => {
  const w = run(toImplementation(), { type: 'assign', assignmentId: 'R1', kind: 'implementation', owner: 'sup: x', status: 'started', evidence: 'x' });
  const done = { type: 'assignment_done', assignmentId: 'R1', expectedVersion: 1, head: 'aaaa1111bbbb' };
  assert.throws(() => applyEvent(w, done, ctx({ prHead: 'cccc2222dddd' })), /GitHub shows cccc2222dddd/);
  const ok = applyEvent(w, { ...done, head: 'cccc222' }, ctx({ prHead: 'cccc2222dddd' })).work;
  assert.equal(ok.requests.find(r => r.type === 'review').head, 'cccc2222dddd', 'review targets the GitHub head');
  const verifiedOld = { ...w, head: 'eeee3333', headVerified: { via: 'github', sha: 'eeee3333', at: T } };
  assert.throws(() => applyEvent(verifiedOld, done, ctx({ prHead: null })), /can't confirm/);
});

test('a finished assignment is recorded as history only: no phase, owner or request change, and only at the current head', () => {
  const w = run(inReview(), { type: 'head', sha: 'ce77aaaa' });
  const ev = { type: 'assign', assignmentId: 'R3', kind: 'fixes', owner: 'sup: s', status: 'done', head: 'ce77aaa', evidence: 'stream report' };
  const s = run(w, ev);
  assert.deepEqual([s.phase, s.owner, s.requests.length], [w.phase, w.owner, w.requests.length]);
  assert.deepEqual([s.assignments[0].status, s.assignments[0].doneHead], ['done', 'ce77aaaa']);
  assert.throws(() => applyEvent(w, { ...ev, head: 'bbbb1111' }, ctx()), /current head/);
});

test('--after waits for the other worker to finish, not for its review', () => {
  const q = run(build(), { type: 'assign', assignmentId: 'R4', kind: 'fixes', owner: 'sup: s', status: 'queued', after: ['W-76'], evidence: 'x' });
  assert.deepEqual(q.deps, [], 'a scheduling wait is not a work dependency');
  const start = { type: 'progress', assignmentId: 'R4', expectedVersion: 1, stage: 'started' };
  assert.throws(() => applyEvent(q, start, ctx({ depPhase: () => 'implementation' })), /W-76/);
  assert.throws(() => applyEvent(q, start, ctx({ depPhase: () => undefined })), /W-76/);
  assert.equal(applyEvent(q, start, ctx({ depPhase: () => 'rereview' })).work.phase, 'fixes');
});

test('the full SHA of the current short head is the same commit: no invalidation, no rereview', () => {
  const w = run(toImplementation(), { type: 'implementation_done', head: '7fdd3cb639e' });
  const s = observeHead(w, { sha: '7fdd3cb639e7e25c07cfabc21b6285179f9f45a7', via: 'github' }, ctx());
  assert.deepEqual([s.phase, s.head, s.requests.find(r => r.type === 'review').head], ['review', '7fdd3cb639e7e25c07cfabc21b6285179f9f45a7', '7fdd3cb639e7e25c07cfabc21b6285179f9f45a7']);
  assert.ok(!s.updates.some(u => /New commit/.test(u.text)));
});

test('a false new-commit move is corrected with a note, keeping the original entry', () => {
  const full = '7fdd3cb639e7e25c07cfabc21b6285179f9f45a7';
  const w = { ...run(toImplementation(), { type: 'implementation_done', head: '7fdd3cb639e' }), phase: 'rereview', head: full };
  w.updates = [...w.updates, { at: T, by: 'github', text: `New commit ${full} replaces 7fdd3cb639e; review, checks and criteria from 7fdd3cb639e no longer count.` }];
  const s = run(w, { type: 'correct_head', from: '7fdd3cb639e', to: full, phase: 'review', evidence: 'same commit' });
  assert.equal(s.phase, 'review');
  assert.ok(s.updates.some(u => /New commit/.test(u.text)) && /Correction/.test(s.updates.at(-1).text));
  assert.throws(() => applyEvent(w, { type: 'correct_head', from: 'aaaa1111', to: full, phase: 'review', evidence: 'x' }, ctx()), /same commit/);
});

test('a review request is refreshed at the current head once, keeping the old one', () => {
  const w = { ...run(toImplementation(), { type: 'implementation_done', head: 'ce77ce77ce6' }), phase: 'rereview', head: '0cc252ebbc9fe35f' };
  const s = run(w, { type: 'request_review', evidence: 'R3 done at 0cc' });
  assert.deepEqual(s.requests.filter(r => r.type === 'review').map(r => r.head), ['ce77ce77ce6', '0cc252ebbc9fe35f']);
  assert.throws(() => applyEvent(s, { type: 'request_review', evidence: 'again' }, ctx()), /already/);
});

test('a running review and a queued fix round coexist; the fix waits for the review unless marked parallel', () => {
  const w = run(inReview(), { type: 'assign', assignmentId: 'R3', kind: 'review', owner: 'pr-8363-trusted-review', status: 'started', evidence: 'x' });
  const fx = { type: 'assign', assignmentId: 'R4', kind: 'fixes', owner: 'sup: s', status: 'queued', evidence: 'blocker' };
  assert.throws(() => applyEvent(w, fx, ctx()), /--after-assignment R3|--parallel/);
  const q = run(w, { ...fx, afterAssignments: ['R3'] });
  assert.deepEqual(q.assignments.map(a => [a.id, a.status]), [['R3', 'started'], ['R4', 'queued']], 'the review is not superseded');
  const start = { type: 'progress', assignmentId: 'R4', expectedVersion: 1, stage: 'started' };
  assert.throws(() => applyEvent(q, start, ctx()), /R3/);
  const reviewed = run(q, { type: 'assignment_done', assignmentId: 'R3', expectedVersion: 1 });
  assert.equal(run(reviewed, start).phase, 'fixes');
  const p = run(w, { ...fx, parallel: true });
  assert.equal(run(p, start).assignments.find(a => a.id === 'R4').status, 'started');
  assert.equal(run(p, { type: 'progress', assignmentId: 'R3', expectedVersion: 1, stage: 'working' }).assignments[0].version, 2, 'each lane reports on its own');
});

test("a trusted review of someone else's PR waits for Alex's own review, at the reviewed head only", () => {
  const inReview = run(build(), { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' }, { type: 'transition', to: 'implementation', owner: 'pr-1-trusted-review' },
    { type: 'implementation_done', head: 'aaa1111' });
  assert.throws(() => run(inReview, { type: 'review_for_alex', head: 'aaa1111', result: 'clean', by: 'pr-1-trusted-review' }), /artifact/);
  const stale = run(inReview, { type: 'review_for_alex', head: 'old0000', result: 'clean', artifact: 'r.md', by: 'pr-1-trusted-review' });
  assert.equal(stale.phase, 'review', 'an older commit leaves the phase alone');
  const w = run(inReview, { type: 'review_for_alex', head: 'aaa1111', result: 'findings', findings: [{ text: 'Human must verify the browser path' }], artifact: 'r.md', by: 'pr-1-trusted-review' });
  assert.deepEqual([w.phase, w.findings.length, w.reviews.at(-1).link], ['awaiting_alex_review', 1, 'r.md']);
  assert.equal(observeHead(w, { sha: 'bbb2222', via: 'github' }, ctx()).phase, 'rereview', 'a new commit needs a new review');
  const done = run(w, { type: 'alex_review_submitted', note: 'approved on GitHub' });
  assert.deepEqual([done.phase, done.completion.kind], ['done', 'alex-review']);
});

test("Alex's own GitHub review, or the PR closing first, finishes a review-for-Alex record", () => {
  const inReview = run(build(), { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' }, { type: 'transition', to: 'implementation', owner: 'pr-1-trusted-review' },
    { type: 'implementation_done', head: 'aaa1111' });
  const waiting = run(inReview, { type: 'review_for_alex', head: 'aaa1111', result: 'clean', artifact: 'r.md', by: 'pr-1-trusted-review' });
  const reviewed = run(waiting, { type: 'alex_review_seen', review: { state: 'APPROVED', at: '2026-10-28T19:00:00Z', url: 'u' } });
  assert.deepEqual([reviewed.phase, reviewed.completion.kind, reviewed.completion.review.state], ['done', 'alex-review', 'APPROVED']);
  const merged = run(waiting, { type: 'alex_review_seen', closedAs: 'MERGED' });
  assert.deepEqual([merged.phase, merged.completion.kind], ['done', 'closed-before-alex-review']);
  assert.throws(() => run(inReview, { type: 'alex_review_seen', closedAs: 'MERGED' }), /trusted review/);
});

test('a merged PR closes the work as merged, only on a verified merge', () => {
  const w = run(build(), { type: 'transition', to: 'ready' });
  assert.throws(() => applyEvent(w, { type: 'merged', prs: [{ url: 'u', state: 'OPEN' }] }, ctx()), /merged/);
  const d = applyEvent(w, { type: 'merged', prs: [{ url: 'u', state: 'MERGED', mergedAt: '2026-10-28T20:00:00Z' }] }, ctx()).work;
  assert.deepEqual([d.phase, d.completion.kind, d.completion.prs[0].url], ['done', 'merged', 'u']);
  const waited = applyEvent({ ...w, waitingOn: { who: 'QA', what: 'x' } }, { type: 'merged', prs: [{ url: 'u', state: 'MERGED' }], outstanding: ['waiting on QA: x'] }, ctx()).work;
  assert.deepEqual([waited.phase, waited.waitingOn], ['done', null]);
  assert.match(waited.updates.at(-1).text, /merged past: waiting on QA: x/);
});

test('a new commit on a PR already marked ready stays in approval wait under the standing waiver; no internal review', () => {
  const standingWaiver = { by: 'Alex', reason: 'PR already marked ready', authorization: 'standing rule' };
  const w0 = { ...build({ links: { pr: 'u' } }), phase: 'awaiting_human_approval', head: 'aaa1111', headVerified: { via: 'github' }, approvalWait: { head: 'aaa1111', prUrl: 'u' }, internalReviewWaivers: [{ head: 'aaa1111', prUrl: 'u' }] };
  const w1 = observeHead(w0, { sha: 'bbb2222', via: 'github', isDraft: false }, ctx({ standingWaiver }));
  assert.deepEqual([w1.phase, w1.approvalWait.head, w1.internalReviewWaivers.at(-1).head, w1.requests.filter(r => r.type === 'review').length], ['awaiting_human_approval', 'bbb2222', 'bbb2222', 0]);
  const draft = observeHead(w0, { sha: 'bbb2222', via: 'github', isDraft: true }, ctx({ standingWaiver }));
  assert.equal(draft.phase, 'rereview', 'back to draft: it needs the internal review again before ready');
  assert.equal(draft.requests.filter(r => r.type === 'review').length, 0, 'no review request on a bare new commit; review comes when the worker reports done');
});

test('a PR link must be a pull request URL, so gates and correlation can match it', () => {
  assert.throws(() => updateWork(build(), { links: { pr: '8469' } }, ctx()), /pull request URL/);
});

test('a red build or a conflict at the head reopens reviewed work as fixes, once per commit', () => {
  const H = 'aaaaaaa1';
  let w = run(updateWork(build(), { links: { pr: PR } }, ctx()), { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' },
    { type: 'transition', to: 'implementation', owner: 'sbx: s' }, { type: 'implementation_done', head: H });
  w = run(evidenced(run(w, { type: 'review', head: H, by: 'reviewer', result: 'clean' })), { type: 'mark_ready' });
  assert.equal(w.phase, 'ready_for_human');
  const red = observeHealth(w, { head: H, conflict: true, failing: ['ci/circleci: test'] }, ctx());
  assert.equal(red.phase, 'fixes');
  assert.deepEqual(red.findings.map(f => f.source.type), ['conflict', 'ci']);
  assert.equal(red.requests.at(-1).type, 'fixes');
  assert.equal(observeHealth(red, { head: H, conflict: true, failing: ['ci/circleci: test'] }, ctx()), red, 'the same commit is never assessed twice');
  assert.equal(observeHealth(w, { head: 'bbbbbbb2', failing: ['x'] }, ctx()), w, 'a read of another commit says nothing about this head');
});

test('work being built gets the health finding but keeps its phase', () => {
  const w = run(toImplementation(), { type: 'head', sha: 'ccccccc3' });
  const red = observeHealth(w, { head: 'ccccccc3', failing: ['Run JS/TS tests'] }, ctx());
  assert.equal(red.phase, 'implementation');
  assert.equal(red.findings.length, 1);
});

test('a blocked report records what it waits on; starting again clears it', () => {
  const w = run(build(), { type: 'assign', assignmentId: 'R1', kind: 'implementation', owner: 'sup: s', status: 'started', evidence: 'x' },
    { type: 'progress', assignmentId: 'R1', expectedVersion: 1, stage: 'blocked', waitingOn: 'TB-9', text: 'needs the field name' });
  assert.deepEqual([w.assignments[0].status, w.assignments[0].waitingOn], ['blocked', 'TB-9']);
  const again = run(w, { type: 'progress', assignmentId: 'R1', expectedVersion: 2, stage: 'started' });
  assert.deepEqual([again.assignments[0].status, again.assignments[0].waitingOn], ['started', null]);
});

test('a build record with no PR and no criteria closes on a resolve note; one with a PR goes through the ready gate', () => {
  const w = run(build({ criteria: [] }), { type: 'resolve', note: 'fixed in abc1234' });
  assert.deepEqual([w.phase, w.completion.kind], ['done', 'resolved']);
  assert.throws(() => run(build({ criteria: [], links: { pr: 'https://github.com/o/r/pull/1' } }), { type: 'resolve', note: 'x' }), /ready gate/);
});

test('resolving a record closes its open assignments with it', () => {
  let w = build({ criteria: [] });
  w = run(w, { type: 'assign', assignmentId: 'R1', kind: 'implementation', status: 'queued', owner: 'board lead', evidence: 'brief' });
  w = run(w, { type: 'resolve', note: 'fixed in abc1234' });
  assert.deepEqual([w.phase, w.assignments[0].status, w.assignments[0].history.at(-1).status], ['done', 'cancelled', 'queued']);
});

test('a reviewer asking for changes or opening threads on a tracked PR reopens it as fixes, once per review and thread (W-207, #8276)', () => {
  const H = 'aaaaaaa1';
  let w = run(updateWork(build(), { links: { pr: PR } }, ctx()), { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' },
    { type: 'transition', to: 'implementation', owner: 'sbx: s' }, { type: 'implementation_done', head: H });
  w = run(evidenced(run(w, { type: 'review', head: H, by: 'reviewer', result: 'clean' })), { type: 'mark_ready' });
  const read = threads => ({ head: H, conflict: false, failing: [], changesRequested: [{ id: 'PRR_1', by: 'sam-built', url: 'u1' }], threads });
  const t = id => ({ id, by: 'sam-built', url: `https://x/${id}` });
  const fb = observeHealth(w, read([t('T1'), t('T2'), t('T3')]), ctx());
  assert.equal(fb.phase, 'fixes');
  assert.deepEqual(fb.findings.map(f => f.source.type), ['changes_requested', 'threads']);
  assert.equal(fb.requests.at(-1).type, 'fixes');
  assert.equal(observeHealth(fb, read([t('T1'), t('T2'), t('T3')]), ctx()), fb, 'the same review and threads are news once');
  const more = observeHealth(fb, read([t('T1'), t('T4')]), ctx());
  assert.deepEqual(more.findings.at(-1).source.ids, ['T4'], 'only the new thread is a new finding');
  assert.equal(observeHealth(w, { head: H, conflict: false, failing: [] }, ctx()), w, 'a read with no review data changes nothing (older rows)');
});

test('W-160 shape: findings given as plain text keep their text, and a later clean review at the same head settles them', () => {
  const H = 'aaaaaaa1', later = ctx({ now: '2026-11-06T00:00:00.000Z' });
  let w = run(updateWork(build(), { links: { pr: PR } }, ctx()), { type: 'transition', to: 'ready' }, { type: 'transition', to: 'queued' },
    { type: 'transition', to: 'implementation', owner: 'sbx: s' }, { type: 'implementation_done', head: H });
  w = applyEvent(w, { type: 'review', head: H, by: 'reviewer 1', result: 'findings', findings: ['Fixed (PR body): Risk 3 understated who is blocked.'] }, later).work;
  assert.equal(w.findings.at(-1).text, 'Fixed (PR body): Risk 3 understated who is blocked.');
  w = applyEvent(w, { type: 'review', head: H, by: 'reviewer 2', result: 'clean' }, later).work;
  assert.equal(w.findings.at(-1).status, 'resolved', 'the later clean review is the final word on this head');
});
