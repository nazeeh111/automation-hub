import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {InboxService,classifyEmployerOutcome} from '../server/inbox.mjs';
import {OutcomeService} from '../server/outcomes.mjs';

const receipt='Your application has been received for Engineering intern REQ-7 at Acme.';
const offer='We would like to offer you the Engineering intern REQ-7 position at Acme.';
const interview='We invite you to an interview for Engineering intern REQ-7 at Acme.';
const assessment='Please complete the assessment for Engineering intern REQ-7 at Acme.';
const cases=[
 ['conditional interview','If you pass our screening, we will invite you to an interview for Engineering intern REQ-7 at Acme.',null],
 ['conditional assessment','If you pass our screening, please complete the assessment for Engineering intern REQ-7 at Acme.',null],
 ['conditional receipt','Once your application has been submitted for Engineering intern REQ-7 at Acme, you will receive a separate confirmation.',null],
 ['cross-sentence conditional offer',offer+' This is contingent on final approval.',null],
 ['cross-sentence withdrawn offer',offer+' Unfortunately, this has been withdrawn.',null],
 ['paragraph conditional offer',offer+'\n\nThis is contingent on final approval.',null],
 ['paragraph withdrawn offer',offer+'\n\nUnfortunately, this has been withdrawn.',null],
 ['same-sentence conditional offer',offer.replace(/\.$/,' if your screening succeeds.'),null],
 ['future interview','We will invite you to an interview for Engineering intern REQ-7 at Acme.',null],
 ['possible assessment','You may complete the assessment for Engineering intern REQ-7 at Acme.',null],
 ['unless assessment',assessment.replace(/^Please/,'Unless screening fails, please'),null],
 ['split prerequisite','If you pass screening,\n'+interview,null],
 ['preceding prerequisite','This invitation is contingent on final approval. '+interview,null],
 ['negated assessment','You need not complete the assessment for Engineering intern REQ-7 at Acme.',null],
 ['withdrawn interview',interview+' Unfortunately, this invitation has been withdrawn.',null],
 ['cancelled assessment',assessment+'\n\nThis has been cancelled.',null],
 ['negated receipt','Your application has not been received. '+receipt,null],
 ['receipt revoked',receipt+' This receipt has been withdrawn.',null],
 ['conflicting current invitations',interview+' '+assessment,null],
 ['conflicting offer and rejection',offer+' We will not move forward with your application.',null],
 ['receipt and withdrawn offer',receipt+' '+offer+' This has been withdrawn.',null],
 ['receipt and conditional future interview',receipt+' If you pass screening, we will invite you to an interview.','submitted'],
 ['receipt and conditional future assessment',receipt+'\n\nIf you pass screening, please complete the assessment.','submitted'],
 ['receipt and both future stages',receipt+' If shortlisted, we will invite you to an interview. If that goes well, please complete the assessment.','submitted'],
 ['affirmative receipt',receipt,'submitted'],
 ['affirmative interview',interview,'interview'],
 ['affirmative assessment',assessment,'assessment'],
 ['affirmative offer',offer,'offer'],
 ['receipt and interview',receipt+' '+interview,'interview'],
 ['receipt and polite conditional footer',receipt+' If you have questions, contact us.','submitted'],
 ['offer and polite conditional footer',offer+' If you have questions, contact us.','offer'],
 ['offer and paragraph polite footer',offer+'\n\nIf you have any questions about this offer, please contact us.','offer'],
 ['same-sentence polite offer footer',offer.replace(/\.$/,', and if you have questions, contact us.'),'offer'],
 ['same-sentence polite receipt footer',receipt.replace(/\.$/,'; if you have questions, contact us.'),'submitted'],
 ['interview and possible contact',interview+' You may contact the team with questions.','interview'],
 ['offer and unrelated modal',offer+' Our office may close early on Fridays.','offer'],
 ['offer and unrelated withdrawal',offer+' The optional parking benefit has been withdrawn.','offer'],
 ['receipt and unrelated conditional',receipt+' If it rains, the office closes early.','submitted'],
 ['rejection with courtesy','Thank you for applying. We will not move forward with your application.','rejected'],
 ['negative offer is rejection','We are unable to offer you the role.','rejected'],
];
for(const [name,text,expected] of cases)test('outcome assertion: '+name,()=>{
 const actual=classifyEmployerOutcome(text);
 assert.equal(actual.proposedOutcome,expected);
 assert.equal(actual.unambiguous,expected!==null);
});

const recipient='candidate@example.test',sender='careers@acme.example',clock=Date.parse('2026-11-16T12:00:00Z');
async function fixture(t,text,{state='uncertain',activeAttempt=true,subject='Acme Engineering intern REQ-7 update'}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-inbox-semantics-')),store=new Store(directory);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const profile=store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:recipient});
 const job=store.put('job',{id:'job',identity:'main|lever:acme|REQ-7',title:'Engineering intern',employer:'Acme',url:'https://jobs.lever.co/acme/REQ-7',state,revision:0,nextAction:'Check matching employer evidence',activeAttemptId:activeAttempt?'run':null,posting:{sourceHash:'posting'}});
 if(activeAttempt)store.put('run',{id:'run',jobId:job.id,state:'uncertain',dispatchedAt:'2026-11-16T11:00:00Z'});
 store.put('decision',{id:'decision',jobId:job.id,jobIds:[job.id],state:'open',code:'submission_uncertain'});
 const raw={id:'message-1',internalDate:String(clock-1000),payload:{mimeType:'text/plain',headers:[{name:'From',value:sender},{name:'To',value:recipient},{name:'Subject',value:subject},{name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=acme.example'}],body:{data:Buffer.from(text).toString('base64url')}}};
 const calls=[],inbox=new InboxService({store,directory,clock:()=>clock,runner:async(method,params)=>{calls.push(method);if(method==='profile')return {emailAddress:recipient};if(method==='list')return {messages:[{id:raw.id}]};if(method==='get'){assert.equal(params.id,raw.id);return raw;}throw new Error('Unexpected injected read');}});
 inbox.configure({email:recipient,enabled:true,confirmed:true,autoTrack:true,expectedSenders:[sender]});
 await inbox.probe({email:recipient,enabled:true,confirmed:true});
 return {store,profile,job,inbox,outcomes:new OutcomeService({store}),raw,calls};
}
// These exercise trusted-payload parsing, exact matching, durable proposals and
// actual acceptance together. All mailbox reads are injected; no provider runs.
for(const [name,text,expected] of cases.filter(([,text])=>text.includes('REQ-7'))){
 test('durable InboxService → OutcomeService: '+name,async t=>{
  const f=await fixture(t,text),before={job:f.store.get('job','job'),run:f.store.get('run','run'),decision:f.store.get('decision','decision')};
  const proposal=(await f.inbox.pollOutcomes([f.job],f.profile)).proposals[0];assert(proposal);
  if(expected===null){
   assert.equal(proposal.confidence,'ambiguous');assert.equal(proposal.proposedOutcome,null);
   assert.throws(()=>f.outcomes.accept(proposal.id,{automatic:true}),e=>e.code==='outcome_review');
   assert.deepEqual(f.store.get('job','job'),before.job);assert.deepEqual(f.store.get('run','run'),before.run);assert.deepEqual(f.store.get('decision','decision'),before.decision);
   assert.equal(f.store.list('event').filter(e=>e.type==='employer_message_recorded').length,0);
   assert.equal(await f.inbox.findPriorSubmission(f.job,f.profile),null);
  }else{
   assert.equal(proposal.confidence,'matched');assert.equal(proposal.proposedOutcome,expected);
   assert.equal(f.outcomes.accept(proposal.id,{automatic:true}).accepted,true);
   assert.equal(f.store.get('job','job').state,expected);assert.equal(f.store.get('decision','decision').state,'resolved');
   assert.equal(f.store.get('run','run').state,expected==='submitted'?'reconciled':'uncertain');
   assert.equal(f.store.get('job','job').evidence[0].outcome,expected);
  }
  assert(f.calls.every(method=>['profile','list','get'].includes(method)));
 });
}

test('conditional future stages preserve affirmative prior receipt detection',async t=>{
 const f=await fixture(t,receipt+' If you pass screening, we will invite you to an interview. If it goes well, please complete the assessment.',{state:'ready',activeAttempt:false});
 const prior=await f.inbox.findPriorSubmission(f.job,f.profile);assert.equal(prior.proposedOutcome,'submitted');assert.equal(prior.confidence,'matched');
 f.outcomes.accept(prior.id,{automatic:true});assert.equal(f.store.get('job','job').priorApplicationDetected,true);
});

test('accepted evidence remains immutable after a later ambiguous rescan',async t=>{
 const f=await fixture(t,offer);const p=(await f.inbox.pollOutcomes([f.job],f.profile)).proposals[0];f.outcomes.accept(p.id,{automatic:true});
 const old=f.store.get('inbox_proposal',p.id),job=f.store.get('job','job');
 // Synthetic same-ID body change probes history protection, not real delivery behavior.
 f.raw.payload.body.data=Buffer.from(offer+' Unfortunately, this has been withdrawn.').toString('base64url');
 const after=(await f.inbox.pollOutcomes([job],f.profile)).proposals[0];assert.equal(after.state,'accepted');assert.deepEqual(after.evidence,old.evidence);assert.deepEqual(after.matchContext,old.matchContext);assert.equal(after.rechecks.at(-1).confidence,'ambiguous');assert.deepEqual(f.store.get('job','job'),job);assert.throws(()=>f.outcomes.dismiss(p.id));
});
