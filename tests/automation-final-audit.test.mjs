import {bindPreparedPosting} from './fixtures/posting.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {ApplicationHold} from '../server/adapters.mjs';
import {InboxService,classifyEmployerOutcome} from '../server/inbox.mjs';
import {OutcomeService} from '../server/outcomes.mjs';

const recipient='synthetic@example.test',sender='careers@example.test';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function job(extra={}){return {id:'job',identity:'main|lever:example:REQ-7',url:'https://jobs.lever.co/example/REQ-7',title:'Engineering intern',employer:'Example Labs',state:'ready',revision:0,packageId:'pkg',posting:{title:'Engineering intern',employer:'Example Labs',open:true,sourceHash:'posting',text:'Synthetic engineering internship.',sourceUrl:'https://jobs.lever.co/example/REQ-7'},...extra};}
async function fixture(t,submit){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-automation-audit-')),store=new Store(directory);
 const profile=store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:recipient,answers:{}});
 store.put('resume',{id:'resume',mega:false});store.put('job',job());
 store.put('package',bindPreparedPosting(store,store.get('job','job'),{id:'pkg',jobId:'job',resumeId:'resume',verified:true,approved:true,hash:'fixture-only',finalPath:'/synthetic-not-opened.pdf',profileRevision:profile.updatedAt,requirements:[]}));
 const engine=new Engine({store,directory,resumes:{prepare:async()=>store.get('package','pkg')},adapter:{inspect:async j=>j.posting,submit:submit||(async()=>({status:'uncertain'})),close:async()=>{}}});
 t.after(async()=>{await engine.stop();store.close();await rm(directory,{recursive:true,force:true});});
 await engine.action('savePolicy',{rules:{maxApplications:10,maxPerEmployer:3,allowedHosts:['jobs.lever.co']}});await engine.action('enableCampaign',{confirmed:true});
 return {store,engine,directory,profile};
}
for(const failure of ['ordinary_timeout','account_access','form_questions','resume_file_requirements'])test('manual takeover owns late '+failure+' before every error side effect',async t=>{
 const entered=deferred(),gate=deferred();
 const f=await fixture(t,async()=>{entered.resolve();await gate.promise;if(failure==='ordinary_timeout')throw new Error('Synthetic timeout');throw new ApplicationHold(failure,'Synthetic delayed failure',{questions:[{label:'Late question'}],document:{label:'Resume',name:'resume',sourceUrl:'https://jobs.lever.co/example/REQ-7'}});});
 const work=f.engine.tick();await entered.promise;await f.engine.action('takeover',{jobId:'job'});const owned=f.store.get('job','job');gate.resolve();
 assert.deepEqual(await work,{revoked:true});assert.deepEqual(f.store.get('job','job'),owned);assert.equal(f.store.list('account').length,0);assert.equal(f.store.list('decision').length,0);await assert.rejects(f.engine.action('retry',{jobId:'job'}),/Only a failed/);
 const manual=await f.engine.action('release',{jobId:'job'});assert.equal(manual.code,'manual_reconciliation');
});
test('a stale revision fences generic failure even when the newer state is not manual',async t=>{
 const f=await fixture(t),old=f.store.get('job','job'),newer=f.store.put('job',{...old,revision:old.revision+1,state:'imported',nextAction:'Newer work owns this job'});
 assert.deepEqual(f.engine.handleError(old,new Error('Late timeout'),'application'),{revoked:true});assert.deepEqual(f.store.get('job','job'),newer);
});
test('genuine dispatched uncertainty survives takeover and cannot be retried',async t=>{
 const entered=deferred(),gate=deferred(),f=await fixture(t,async(j,p,k,{beforeDispatch})=>{beforeDispatch();entered.resolve();await gate.promise;throw new Error('Connection lost after dispatch');});
 const work=f.engine.tick();await entered.promise;await f.engine.action('takeover',{jobId:'job'});gate.resolve();await work;
 assert.equal(f.store.get('job','job').state,'uncertain');assert.equal(f.store.get('run',f.store.get('job','job').activeAttemptId).state,'uncertain');await assert.rejects(f.engine.action('retry',{jobId:'job'}),/receipt/);
});
for(const outcome of ['submitted','interview','assessment','rejected','offer','closed'])test('matching recorded '+outcome+' evidence prevents accidental ready dispatch',async t=>{
 let dispatches=0;const f=await fixture(t,async()=>{dispatches++;return {status:'uncertain'};});
 await f.engine.action('recordOutcome',{jobId:'job',outcome,evidence:{url:'https://jobs.lever.co/example/receipt',reference:'synthetic-'+outcome,employer:'Example Labs',title:'Engineering intern',email:recipient}});
 const recorded=f.store.get('job','job');f.store.put('job',{...recorded,state:'ready',revision:recorded.revision+1});
 const result=await f.engine.tick();assert.equal(result.alreadyApplied,true);assert.equal(f.store.get('job','job').state,outcome);assert.equal(dispatches,0);assert.equal(f.store.list('run').length,0);
});
test('legacy outcome event restores a matching receipt without trusting an unrelated record',async t=>{
 let dispatches=0;const f=await fixture(t,async()=>{dispatches++;return {status:'uncertain'};});
 const current=f.store.get('job','job');f.store.put('job',{...current,evidence:[{id:'legacy',type:'candidate_attested_receipt',jobId:current.id,identity:current.identity,employer:current.employer,title:current.title,email:recipient}]});f.store.event(current.id,'outcome_recorded',{outcome:'interview',evidenceId:'legacy'});
 await f.engine.tick();assert.equal(f.store.get('job','job').state,'interview');assert.equal(dispatches,0);
});
test('changing the application email cannot repeat a receipt-bound role for the same candidate',async t=>{
 let dispatches=0;const f=await fixture(t,async()=>{dispatches++;return {status:'uncertain'};});
 await f.engine.action('recordOutcome',{jobId:'job',outcome:'submitted',evidence:{url:'https://jobs.lever.co/example/receipt',reference:'synthetic',employer:'Example Labs',title:'Engineering intern',email:recipient}});
 const profile=f.store.put('profile',{...f.profile,email:'new-address@example.test'}),current=f.store.get('job','job');f.store.put('package',{...f.store.get('package','pkg'),profileRevision:profile.updatedAt});f.store.put('job',{...current,state:'ready',revision:current.revision+1});await f.engine.action('enableCampaign',{confirmed:true});await f.engine.tick();
 assert.equal(dispatches,0);assert.equal(f.store.get('job','job').state,'needs_you');assert.equal(f.store.list('decision').find(d=>d.state==='open').code,'prior_application_uncertain');
});

const classificationCases=[
 ['We are pleased to offer you the Engineering intern position.','offer'],
 ['We are delighted to extend an employment offer.','offer'],
 ['We would like to offer you the internship.','offer'],
 ['We are unable to offer you an internship at this time. Thank you for applying.','rejected'],
 ['We cannot extend an offer of employment.','rejected'],
 ['We will not be extending an offer. Thank you for applying.',null],
 ['If your assessment is successful, we are pleased to offer you a role.',null],
 ['We are pleased to offer you a role. This offer is contingent on approval.',null],
 ['We may offer you employment after the interview.',null],
 ['We are pleased to offer you a role. We will not move forward with your application.',null],
 ['We are not pleased to offer you this position.',null],
 ['We received your application. Offers will be made next month.',null],
 ['We have received your application.','submitted'],
 ['Thank you for applying. We will not move forward with your application.','rejected'],
 ['We invite you to an interview.','interview'],
 ['Please complete our assessment.','assessment'],
 ['We will not schedule an interview.',null],
 ['You should not complete our assessment.',null],
 ['Thank you for applying, but your application was not submitted.',null]
];
for(const [text,expected] of classificationCases)test('bounded employer outcome meaning: '+text,()=>{assert.equal(classifyEmployerOutcome(text).proposedOutcome,expected);});

function message(text,{id='synthetic-message',subject='Example Labs Engineering intern REQ-7 update'}={}){return {id,internalDate:String(Date.now()-1000),payload:{mimeType:'text/plain',headers:[{name:'From',value:sender},{name:'To',value:recipient},{name:'Subject',value:subject},{name:'Authentication-Results',value:'mx.google.com; dmarc=pass header.from=example.test'}],body:{data:Buffer.from(text).toString('base64url')}}};}
async function inboxFixture(t,{raw=message('Your application has been received by Example Labs for Engineering intern REQ-7.'),duringGet}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-outcome-binding-')),store=new Store(directory),profile=store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:recipient,answers:{}});
 const current=store.put('job',job({state:'manual'}));
 const inbox=new InboxService({store,directory,runner:async method=>{if(method==='profile')return {emailAddress:recipient};if(method==='list')return {messages:[{id:raw.id}]};if(method==='get'){duringGet?.(store);return raw;}assert.fail('Unexpected inbox method');}});
 inbox.configure({email:recipient,enabled:true,confirmed:true,expectedSenders:[sender],autoTrack:true});await inbox.probe({email:recipient,enabled:true,confirmed:true});
 const outcomes=new OutcomeService({store});t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 return {store,profile,inbox,outcomes,job:current};
}
test('negative offer mail records explicit rejection rather than a fabricated offer',async t=>{
 const f=await inboxFixture(t,{raw:message('Example Labs Engineering intern REQ-7. We are unable to offer you an internship at this time. Thank you for applying.')});
 const proposal=(await f.inbox.pollOutcomes([f.job],f.profile)).proposals[0];assert.equal(proposal.proposedOutcome,'rejected');f.outcomes.accept(proposal.id,{automatic:true});assert.equal(f.store.get('job','job').state,'rejected');assert.equal(f.store.get('job','job').evidence[0].outcome,'rejected');
});
for(const change of ['profile','posting','new-distinct-peer','same-requisition-peer','candidate-email'])test('acceptance fences current '+change+' after a matched proposal',async t=>{
 const f=await inboxFixture(t),proposal=(await f.inbox.pollOutcomes([f.job],f.profile)).proposals[0];assert.equal(proposal.confidence,'matched');
 if(change==='profile')f.store.put('profile',{...f.profile,availability:'Changed availability'});
 else if(change==='candidate-email')f.store.put('profile',{...f.profile,email:'different@example.test'});
 else if(change==='posting')f.store.put('job',{...f.job,posting:{...f.job.posting,sourceHash:'new-posting'}});
 else f.store.put('job',job({id:'peer',identity:'main|other-role',url:'https://jobs.lever.co/example/'+(change==='same-requisition-peer'?'REQ-7':'REQ-8'),state:'imported'}));
 assert.throws(()=>f.outcomes.accept(proposal.id,{automatic:true}),/changed|no longer matches/);assert.equal(f.store.get('job','job').state,'manual');assert.equal(f.store.get('inbox_proposal',proposal.id).state,'open');assert.equal(f.store.list('event').length,0);
});
test('peer imported during the awaited inbox read cannot pass atomic acceptance',async t=>{
 const f=await inboxFixture(t,{duringGet:store=>{if(!store.get('job','peer'))store.put('job',job({id:'peer',identity:'main|other-role',url:'https://jobs.lever.co/example/REQ-8',state:'imported'}));}});
 const proposal=(await f.inbox.pollOutcomes([f.job],f.profile)).proposals[0];assert.equal(proposal.confidence,'matched');assert.throws(()=>f.outcomes.accept(proposal.id,{automatic:true}),/context changed/);assert.equal(f.store.get('job','job').state,'manual');
});
test('legacy proposals require a fresh check and unchanged current bindings accept idempotently',async t=>{
 const f=await inboxFixture(t);let proposal=(await f.inbox.pollOutcomes([f.job],f.profile)).proposals[0];const legacy={...proposal};delete legacy.matchContext;f.store.put('inbox_proposal',legacy);assert.throws(()=>f.outcomes.accept(proposal.id),/context changed/);
 proposal=(await f.inbox.pollOutcomes([f.job],f.profile)).proposals[0];assert.ok(proposal.matchContext);assert.equal(f.outcomes.accept(proposal.id,{automatic:true}).accepted,true);const accepted=f.store.get('job','job');assert.equal(f.outcomes.accept(proposal.id,{automatic:true}).replayed,true);assert.deepEqual(f.store.get('job','job'),accepted);
});
test('accepted proposal retains its recorded confidence and dated recheck when new context is ambiguous',async t=>{
 const f=await inboxFixture(t,{raw:message('Your application has been received by Example Labs for Engineering intern.',{subject:'Example Labs Engineering intern update'})});
 f.job=f.store.put('job',{...f.job,url:'https://careers.example.test/new-york',identity:f.job.identity});let proposal=(await f.inbox.pollOutcomes([f.job],f.profile)).proposals[0];assert.equal(proposal.confidence,'matched');f.outcomes.accept(proposal.id,{automatic:true});const accepted=f.store.get('inbox_proposal',proposal.id);
 f.store.put('job',job({id:'peer',identity:'main|boston',url:'https://careers.example.test/boston',state:'manual'}));await f.inbox.pollOutcomes(f.store.list('job'),f.profile);proposal=f.store.get('inbox_proposal',proposal.id);
 assert.equal(proposal.state,'accepted');assert.equal(proposal.confidence,accepted.confidence);assert.equal(proposal.evidenceId,accepted.evidenceId);assert.deepEqual(proposal.matchContext,accepted.matchContext);assert.equal(proposal.rechecks.length,1);assert.equal(proposal.rechecks[0].confidence,'ambiguous');assert.ok(Number.isFinite(Date.parse(proposal.rechecks[0].observedAt)));assert.equal(f.store.get('job','job').state,'submitted');
 await f.inbox.pollOutcomes(f.store.list('job'),f.profile);assert.equal(f.store.get('inbox_proposal',proposal.id).rechecks.length,1);
});
