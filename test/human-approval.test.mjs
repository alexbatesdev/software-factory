import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWork, applyEvent, observeHead, unverifyHead, updateWork } from '../core/work.mjs';
import { categoryOf } from '../views/category.mjs';
const url='https://github.com/builtforteams/built-rails/pull/8363', head='557021cfb53b6614b67da0a799e49398f892c92c';
const ctx={now:'2026-10-27T21:40:00Z',by:'Dot',openQuestions:0};
const make=()=>({...createWork({id:'W-1',title:'Ready PR',links:{pr:url},criteria:['Accepted behavior']},ctx),phase:'rereview',head});
const event={type:'await_approval',head,prs:[{url}],evidence:'Alex explicit approval in parent transcript',waiver:{by:'Alex',reason:'Grandfathered ready PR; internal review waived',authorization:'User yes, 2026-10-27'}};
const verified={...ctx,verifiedPrs:[{url,head,state:'OPEN',isDraft:false}]};
const run=(w,e,c=ctx)=>applyEvent(w,e,c).work;
test('approval wait records a head-bound waiver separately, never an invented review/check/criterion acceptance',()=>{
 const w=run(make(),event,verified);
 assert.equal(w.phase,'awaiting_human_approval');
 assert.deepEqual(w.reviews,[]);assert.deepEqual(w.checks,[]);assert.equal(w.criteria[0].acceptedHead,null);
 assert.equal(w.internalReviewWaivers[0].by,'Alex');assert.equal(w.internalReviewWaivers[0].head,head);
 assert.deepEqual(w.approvalWait.requiredApprovals,{qa:1,dev:1});
 assert.equal(categoryOf({work:w}).category,'prreview');
 assert.equal(run(w,event,verified).internalReviewWaivers.length,1,'retry does not duplicate waiver');
});
test('approval wait needs a live ready PR at precisely the authorized current commit',()=>{
 for(const remote of [null,{url,head,state:'OPEN',isDraft:true},{url,head,state:'MERGED',isDraft:false},{url,head:'aaaaaaaaaaaaaaaa',state:'OPEN',isDraft:false}])
  assert.throws(()=>run(make(),event,{...ctx,verifiedPrs:remote?[remote]:[]}),/ready|current|commit|GitHub/i);
 assert.throws(()=>run(make(),{...event,waiver:null},verified),/review|gate/i);
 assert.throws(()=>run(make(),{type:'transition',to:'awaiting_human_approval'}),/event|move/i);
});
test('new commits and changed/unreadable PR links invalidate waiting status; historical waiver survives',()=>{
 const w=run(make(),event,verified);
 const next=observeHead(w,{sha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',via:'github'},ctx);
 assert.equal(next.phase,'rereview');assert.equal(next.approvalWait,null);assert.equal(next.internalReviewWaivers[0].head,head);
 assert.equal(unverifyHead({...w,headVerified:{via:'github',sha:head}},ctx).phase,'rereview');
 assert.equal(updateWork(w,{links:{pr:url+'0'}},ctx).phase,'rereview');
});
test('no-change completion preserves declined review history without requesting or fabricating a review',()=>{
 const w=createWork({id:'W-2',title:'Already satisfied'},ctx);
 w.phase='review';w.assignments=[{id:'A1',kind:'implementation',status:'done',version:2,noChange:{verifiedOn:'3df3ac0afb9',evidence:'browser + controller:227'}}];
 w.requests=[{id:'R1',type:'review',ack:{outcome:'declined',by:'head',note:'no code deliverable'}}];
 const x=run(w,{type:'complete_no_change',assignmentId:'A1',expectedVersion:2,evidence:'Alex approved no-code closure'});
 assert.equal(x.phase,'done');assert.equal(x.completion.kind,'no-change');assert.deepEqual(x.requests,w.requests);assert.deepEqual(x.reviews,[]);
 assert.throws(()=>run({...w,links:{pr:url}},{type:'complete_no_change',assignmentId:'A1',expectedVersion:2,evidence:'x'}),/PR|deliverable/i);
 assert.throws(()=>run(w,{type:'complete_no_change',assignmentId:'A1',expectedVersion:1,evidence:'x'}),/version/i);
});

test('a ready operation enters human approval wait only after the real internal gate passes',()=>{
 const w=make(); w.phase='ready_for_human';w.headVerified={via:'github',sha:head};
 w.reviews=[{head,by:'independent-reviewer',result:'clean'}];w.checks=[{head,name:'test',result:'pass'}];w.criteria[0].acceptedHead=head;
 const x=run(w,{type:'pr_ready_op',opId:'P1',head,prUrl:url,status:'confirmed'});
 assert.equal(x.phase,'awaiting_human_approval');assert.equal(x.internalReviewWaivers?.length||0,0);
 assert.equal(observeHead(x,{sha:head,via:'github',isDraft:true},ctx).phase,'rereview');
});
test('no-change reports cannot bypass an actual PR deliverable or a running review',()=>{
 const w=make();w.phase='implementation';w.assignments=[{id:'A1',kind:'implementation',status:'started',version:1,history:[]}];
 const e={type:'assignment_done',assignmentId:'A1',expectedVersion:1,noChange:{verifiedOn:head,evidence:'already satisfied'}};
 assert.throws(()=>run(w,e),/PR|deliverable/i);assert.equal(w.assignments[0].status,'started','failed close is atomic');
 const n={...w,links:{},assignments:[...w.assignments,{id:'A2',kind:'review',status:'started',version:1}]};
 assert.throws(()=>run(n,e),/active/i);
});

test('a waiver can be recorded independently while newer queued fixes retain their phase and ownership',()=>{
 const w=make();w.assignments=[{id:'R5',kind:'fixes',owner:'Stream 1',status:'queued',version:1}];
 assert.throws(()=>run(w,event,verified),/active assignment/i);
 const x=run(w,{...event,type:'waive_internal_review'},verified);
 assert.equal(x.phase,w.phase);assert.deepEqual(x.assignments,w.assignments);assert.equal(x.internalReviewWaivers[0].head,head);assert.equal(x.approvalWait,undefined);assert.deepEqual(x.reviews,[]);
 assert.equal(observeHead(x,{sha:'dddddddddddddddddddddddddddddddddddddddd',via:'github'},ctx).internalReviewWaivers[0].head,head);
});
