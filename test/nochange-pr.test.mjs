import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as W from '../core/work.mjs';
const head='572fa725876a738f6bd76637151b51f5ee3fa246', url='https://github.com/builtforteams/built-rails/pull/8363';
const ctx={now:'2026-10-27T23:40:00Z',by:'fixture',openQuestions:0,verifiedPrs:[{url,head,state:'OPEN',isDraft:false}],prHead:head,prState:{url,head,state:'OPEN',isDraft:false}};
const ev=(w,e,c=ctx)=>W.applyEvent(w,e,c).work;
function ready(){let w=W.createWork({id:'W-1',title:'PR fixture',links:{pr:url}},ctx);w=ev(w,{type:'head',sha:head});return ev(w,{type:'await_approval',head,prs:[{url}],evidence:'fixture',waiver:{by:'Alex',reason:'Explicit fixture waiver',authorization:'fixture only'}});}
const assign=w=>ev(w,{type:'assign',assignmentId:'R6',kind:'fixes',status:'started',owner:'worker',evidence:'No-change probe brief'});
const done={type:'assignment_done',assignmentId:'R6',expectedVersion:1,noChange:{verifiedOn:head,evidence:'Reloaded records; all display/filter sets identical'}};
test('an explicit no-change PR probe finishes only its assignment, restores existing human approval wait and creates no review request',()=>{
 const before=ready(), running=assign(before), x=ev(running,done);
 assert.equal(x.assignments.at(-1).status,'done');assert.equal(x.assignments.at(-1).noChange.verifiedOn,head);
 assert.deepEqual(x.requests,before.requests);assert.equal(x.phase,'awaiting_human_approval');assert.deepEqual(x.approvalWait,before.approvalWait);
 for(const k of ['internalReviewWaivers','reviews','criteria','checks','findings','completion'])assert.deepEqual(x[k],before[k],k);
});
test('a no-change probe on an unreviewed PR preserves its pending human/internal work without adding a request or waiver',()=>{
 let w=ready();w.phase='rereview';w.approvalWait=null;w.internalReviewWaivers=[];w.requests=[{id:'R1',type:'review',head,at:'2026-10-27T23:00:00Z',ack:null}];
 const x=ev(assign(w),done);assert.equal(x.phase,'rereview');assert.deepEqual(x.requests,w.requests);assert.deepEqual(x.reviews,[]);assert.deepEqual(x.internalReviewWaivers,[]);assert.notEqual(x.phase,'done');
});
test('no-change requires explicit evidence, a recorded unchanged baseline and a fresh matching PR read; changed code is rejected atomically',()=>{
 const w=assign(ready());
 for(const [e,c] of [[{...done,noChange:{verifiedOn:head}},ctx],[done,{...ctx,prState:null,prHead:null}],[done,{...ctx,prState:{...ctx.prState,head:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},prHead:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}]])assert.throws(()=>ev(w,e,c),/evidence|GitHub|head|commit|unchanged/i);
 const changed=W.observeHead(w,{sha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',via:'github'},ctx);
 assert.throws(()=>ev(changed,{...done,noChange:{...done.noChange,verifiedOn:changed.head}},{...ctx,prHead:changed.head,prState:{...ctx.prState,head:changed.head}}),/baseline|started|unchanged/i);
 assert.equal(w.assignments.at(-1).status,'started');
});
test('ordinary done with no explicit no-change outcome still requests review even at the same commit',()=>{
 const x=ev(assign(ready()),{type:'assignment_done',assignmentId:'R6',expectedVersion:1,head});
 assert.equal(x.phase,'rereview');assert.equal(x.requests.at(-1).type,'review');assert.equal(x.requests.at(-1).assignment,'R6');
});
test('current request projection ignores previous heads and assignments but retains their history',()=>{
 const w=ready();w.phase='rereview';w.requests=[{id:'R1',type:'review',head:'557021cfb53',at:'2026-10-27T21:00:00Z',ack:{outcome:'done'}}];
 assert.equal(W.phaseRequest(w),null);
 w.requests.push({id:'R2',type:'review',head,assignment:'old',at:'2026-10-27T23:40:00Z',ack:{outcome:'done'}});
 w.assignments=[{id:'new',kind:'fixes',status:'done',at:'2026-10-27T23:30:00Z'}];assert.equal(W.phaseRequest(w),null);
 w.requests.push({id:'R3',type:'review',head,assignment:'new',at:'2026-10-27T23:40:00Z',ack:null});assert.equal(W.phaseRequest(w).id,'R3');assert.equal(w.requests.length,3);
 w.requests=[{id:'R0',type:'review',head,at:'2026-10-27T22:00:00Z',ack:{outcome:'done'}}];assert.equal(W.phaseRequest(w),null,'legacy same-head request predates the newer assignment');
});

test('an uncorrelated legacy request at the same timestamp as a newer assignment is not current',()=>{
 const w=ready();w.phase='rereview';w.assignments=[{id:'new',kind:'fixes',status:'done',at:ctx.now}];w.requests=[{id:'old',type:'review',head,at:ctx.now,ack:{outcome:'done'}}];assert.equal(W.phaseRequest(w),null);
 w.requests.push({id:'new',type:'review',head,assignment:'new',at:ctx.now,ack:null});assert.equal(W.phaseRequest(w).id,'new');
});

test('an explicit no-change legacy completion cannot silently become a code review request',()=>{
 const w=ready();w.phase='implementation';assert.throws(()=>ev(w,{type:'implementation_done',head,noChange:{verifiedOn:head,evidence:'Explicit no-code outcome'}}),/no-change.*assignment|assignment.*no-change/i);
});
test('a no-change fixes round on red CI accepts the CI finding with its verdict and puts a ready PR back in approval wait',()=>{
 const red=W.observeHealth(ready(),{head,conflict:false,failing:['ci/circleci: test']},ctx);
 assert.equal(red.phase,'fixes');
 const x=ev(assign(red),{...done,noChange:{verifiedOn:head,evidence:'flake: import_spec:118; red on main: participant_spec:454'}},{...ctx,now:'2026-11-05T00:00:00Z'});
 assert.deepEqual(x.findings.map(f=>[f.status,f.note]),[['accepted','No change (R6): flake: import_spec:118; red on main: participant_spec:454']]);
 assert.deepEqual([x.phase,x.approvalWait?.head],['awaiting_human_approval',head]);
});

test('W-80 shape: a CI finding from an old head closes when the head moves, and a round left in fixes always has a request (W-208)', () => {
 const later = { ...ctx, now: '2026-11-06T00:00:00Z' };
 const B = 'b'.repeat(40), atB = { ...later, prHead: B, prState: { ...ctx.prState, head: B }, verifiedPrs: [{ url, head: B, state: 'OPEN', isDraft: false }] };
 let w = W.observeHealth(ready(), { head, conflict: false, failing: ['ci/circleci: test'] }, later);
 w = W.observeHead(w, { sha: B, via: 'github' }, atB);
 assert.deepEqual(w.findings.map(f => f.status), ['resolved'], 'the old head\'s CI finding is superseded');
 w = W.observeHealth(w, { head: B, conflict: false, failing: ['ci/circleci: test'] }, atB);
 w.findings.push({ id: 'F9', text: 'a reviewer finding still open', status: 'open', severity: null, reviewHead: B, note: null });
 w = ev(w, { type: 'assign', assignmentId: 'R6', kind: 'fixes', status: 'started', owner: 'worker', evidence: 'No-change probe brief' }, atB);
 const x = ev(w, { type: 'assignment_done', assignmentId: 'R6', expectedVersion: 1, noChange: { verifiedOn: B, evidence: 'red on main: participant_spec:454' } }, atB);
 assert.equal(x.phase, 'fixes');
 assert.ok(x.requests.some(r => r.type === 'fixes' && !r.ack && r.head === B), 'fixes with nothing pending would strand the record');
});
