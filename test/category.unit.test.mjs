import { test } from 'node:test';
import assert from 'node:assert/strict';
import { categoryOf } from '../views/category.mjs';

const w = (over = {}) => ({ id: 'W-1', phase: 'intake', assignments: [], coverage: null, waitingOn: null, ...over });
const q = (status, over = {}) => ({ id: 'TB-1', status, verification: 'unverified', ...over });
const cat = (rec, work, questions = []) => categoryOf({ rec, work, questions });

test('record state outranks the classifier', () => {
  assert.equal(cat({ triage: { bucket: 'rewrite' } }, w({ phase: 'done' })).category, 'history');
  assert.equal(cat({ triage: { bucket: 'rewrite' } }, w({ phase: 'cancelled' })).category, 'history');
  assert.equal(cat({ triage: { bucket: 'rewrite' } }, w({ phase: 'review' })).category, 'waiting', 'review with nobody working on it waits; In progress is agents working now');
  assert.equal(cat({ triage: { bucket: 'rewrite' } }, w({ coverage: { state: 'open-pr' } })).category, 'prreview', 'covered by an open PR: waiting on PR review');
  assert.equal(cat({ triage: { bucket: 'clarify' } }, w({ assignments: [{ status: 'started' }] })).category, 'progress');
  assert.equal(cat({ triage: { bucket: 'rewrite' } }, w({ waitingOn: { who: 'Chelsie (QA)', what: 'QA' } })).category, 'waiting');
  assert.equal(cat({ triage: { bucket: 'human' }, intakeHold: { by: 'Alex' } }, w({ phase: 'review' })).category, 'untriaged', 'an explicit hold wins');
});

test('open questions keep clarify or rewrite; unverified ones say so', () => {
  const r = cat({ triage: { bucket: 'rewrite' } }, w(), [q('open')]);
  assert.deepEqual([r.category, /unverified/.test(r.reason)], ['rewrite', true]);
  assert.equal(cat({ triage: { bucket: 'ready' } }, w(), [q('open')]).category, 'clarify', 'an open question is never Ready');
});

test('settled-only is not Ready; answered by Alex is', () => {
  const s = cat({ triage: { bucket: 'clarify' } }, w(), [q('settled')]);
  assert.notEqual(s.category, 'ready');
  assert.match(s.reason, /settled/);
  assert.equal(cat({ triage: { bucket: 'clarify' } }, w(), [q('answered')]).category, 'ready');
  assert.equal(cat({ triage: { bucket: 'clarify' }, bucket: 'human' }, w(), []).category, 'human', 'a manual move stands when state says nothing');
});

test('Ready needs every recorded question answered by Alex; none, settled or mixed is not Ready', () => {
  const rec = { triage: { bucket: 'clarify' } };
  assert.notEqual(cat(rec, w(), []).category, 'ready', 'no question at all');
  assert.notEqual(cat(rec, w(), [q('settled', { id: 'TB-1' }), q('answered', { id: 'TB-2' })]).category, 'ready', 'settled scope is not an answer');
  assert.equal(cat(rec, w(), [q('answered', { id: 'TB-2' })]).category, 'ready');
});

test('stale open-PR coverage does not claim an open PR', () => {
  const r = cat({ triage: { bucket: 'rewrite' } }, w({ coverage: { state: 'open-pr', stale: { states: ['#1 MERGED'] } } }));
  assert.notEqual(r.category, 'progress');
  assert.match(r.reason, /MERGED/);
});
