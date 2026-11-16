import '../server/runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {AppVault} from '../server/vault.mjs';
import {EmployerAccountAdapter} from '../server/account-adapter.mjs';
import {OutcomeService} from '../server/outcomes.mjs';
import {outcomeMatchContext} from '../server/inbox.mjs';
import {consentFingerprint} from '../server/adapters.mjs';

const passphrase='synthetic integration passphrase only';
const candidate={id:'main',fullName:'Synthetic Candidate',email:'candidate@example.test'};
const sender='recruiting@employer.example';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
async function setup(t,{vault=false}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-integration-security-')),store=new Store(directory);
 const appVault=vault?new AppVault({directory:path.join(directory,'private-vault')}):null;
 t.after(async()=>{if(appVault)await appVault.close();store.close();await rm(directory,{recursive:true,force:true});});
 store.put('profile',candidate);if(appVault)await appVault.setup(passphrase);
 return {directory,store,vault:appVault};
}
function seedJob(ctx,overrides={}){
 const job=ctx.store.put('job',{id:'job-a',identity:'main|lever:employer|REQ-A',url:'https://jobs.lever.co/employer/REQ-A',title:'Sensor engineering intern',employer:'Example Employer',state:'submitted',revision:0,evidence:[],nextAction:'Await employer response',...overrides});
 ctx.store.put('connection',{id:'inbox',enabled:true,verified:true,email:candidate.email,recipients:[candidate.email],expectedSenders:[sender],autoTrack:true,revision:1});return job;
}
function seedProposal(ctx,job,overrides={}){
 const messageId=overrides.messageId||'message-a';const {evidence:changes,...rest}=overrides;
 return ctx.store.put('inbox_proposal',{id:'proposal-'+messageId,jobId:job.id,jobIdentity:job.identity,candidateEmail:candidate.email,messageId,proposedOutcome:'submitted',confidence:'matched',state:'open',matchContext:outcomeMatchContext(job,ctx.store.get('profile','main'),ctx.store.list('job')),...rest,evidence:{source:'gmail',sender,recipient:candidate.email,subject:'Application received',employer:job.employer,title:job.title,requisition:'REQ-A',authentication:'gmail-dmarc-header-pass',quote:'We received your application for Sensor engineering intern, REQ-A at Example Employer.',messageUrl:'https://mail.google.com/mail/u/0/#all/'+messageId,receivedAt:'2026-11-14T15:00:00Z',matches:{trustedSender:true,recipient:true,deliveryWindow:true,employer:true,role:true,requisition:true,uniqueJob:true},...changes}});
}

test('an explicit lock wins over an unlock already deriving its key',async t=>{
 const ctx=await setup(t,{vault:true});ctx.vault.lock();const pending=ctx.vault.unlock(passphrase);ctx.vault.lock();await pending;
 assert.equal(ctx.vault.isUnlocked(),false);
 await assert.rejects(ctx.vault.get('unused',{tenant:'jobs.lever.co/employer',candidateId:'main',purpose:'browser_session'}),e=>e.code==='vault_locked');
});

test('locking while initial setup is pending leaves the newly created vault locked',async t=>{
 const ctx=await setup(t);const vault=new AppVault({directory:path.join(ctx.directory,'new-vault')});t.after(()=>vault.close());
 const pending=vault.setup(passphrase);vault.lock();await pending;assert.equal((await vault.status()).configured,true);assert.equal(vault.isUnlocked(),false);
});

test('locking during a new encrypted write cannot silently seal the entry with a zeroed key',async t=>{
 const ctx=await setup(t,{vault:true}),entered=deferred(),release=deferred(),load=ctx.vault.load.bind(ctx.vault);
 const binding={tenant:'jobs.lever.co/employer',candidateId:'main',purpose:'employer_credentials'};
 let gated=true;ctx.vault.load=async()=>{if(gated){entered.resolve();await release.promise;}return load();};
 const pending=ctx.vault.put('new-credential',binding,{password:'synthetic-write-secret'});
 await entered.promise;ctx.vault.lock();gated=false;release.resolve();const result=await Promise.allSettled([pending]);ctx.vault.load=load;
 await ctx.vault.unlock(passphrase);
 if(result[0].status==='fulfilled')assert.equal((await ctx.vault.get('new-credential',binding)).password,'synthetic-write-secret','A fulfilled write must remain decryptable after authorized unlock');
 else assert.equal(await ctx.vault.get('new-credential',binding),null,'An interrupted write must not leave an unreadable new entry');
});

test('manual revocation during browser session export prevents authenticated state and job resumption',async t=>{
 const ctx=await setup(t,{vault:true});const adapter=new EmployerAccountAdapter({store:ctx.store,vault:ctx.vault});
 const account=await adapter.saveExisting({tenant:'jobs.lever.co/employer',email:candidate.email,password:'synthetic-employer-password'});
 const saved=ctx.store.get('account',account.id),entered=deferred(),release=deferred();let revoked=false;
 const guard=()=>{if(revoked)throw Object.assign(new Error('Synthetic manual takeover'),{code:'action_revoked'});};
 const pending=adapter.saveSession(saved,{storageState:async()=>{entered.resolve();await release.promise;return {cookies:[],origins:[]};}},guard);
 await entered.promise;revoked=true;release.resolve();await assert.rejects(pending,e=>e.code==='action_revoked');
 assert.equal(ctx.store.get('account',account.id).state,'authorized_existing');
 assert.equal(ctx.store.get('account',account.id).sessionRef,null);
});

test('revocation while encrypted session persistence finishes cannot mark the account ready',async t=>{
 const ctx=await setup(t,{vault:true}),adapter=new EmployerAccountAdapter({store:ctx.store,vault:ctx.vault});
 const publicAccount=await adapter.saveExisting({tenant:'jobs.lever.co/employer',email:candidate.email,password:'synthetic-employer-password'});
 const account=ctx.store.get('account',publicAccount.id),entered=deferred(),release=deferred(),put=ctx.vault.put.bind(ctx.vault);let revoked=false;
 ctx.vault.put=async(ref,binding,value)=>{const result=await put(ref,binding,value);if(binding.purpose==='browser_session'){entered.resolve();await release.promise;}return result;};
 const guard=()=>{if(revoked)throw Object.assign(new Error('Synthetic pause'),{code:'action_revoked'});};
 const pending=adapter.saveSession(account,{storageState:async()=>({cookies:[{name:'session',value:'synthetic-session-secret',domain:'jobs.lever.co',path:'/'}],origins:[]})},guard);
 await entered.promise;revoked=true;release.resolve();await assert.rejects(pending,e=>e.code==='action_revoked');
 assert.equal(ctx.store.get('account',account.id).state,'authorized_existing');assert.equal(ctx.store.get('account',account.id).sessionRef,null);
 assert(!JSON.stringify(ctx.store.list('account')).includes('synthetic-session-secret'));
 assert(!(await readFile(ctx.vault.path,'utf8')).includes('synthetic-session-secret'));
});

test('a newer submission receipt confirms evidence without downgrading an interview or offer',async t=>{
 for(const state of ['interview','assessment','offer','rejected']){
  const ctx=await setup(t),job=seedJob(ctx,{state,lastEmployerMessageAt:'2026-11-14T14:00:00Z'}),proposal=seedProposal(ctx,job),outcomes=new OutcomeService({store:ctx.store});
  outcomes.accept(proposal.id,{automatic:true});
  const actual=ctx.store.get('job',job.id);assert.equal(actual.state,state,`Receipt must not downgrade ${state}`);assert.equal(actual.submissionConfirmation,'employer_confirmed');assert.equal(actual.evidence.length,1);
 }
});

test('recording one job receipt does not clear a shared employer account/security decision',async t=>{
 const ctx=await setup(t),job=seedJob(ctx,{state:'uncertain'});seedJob(ctx,{id:'job-b',identity:'main|lever:employer|REQ-B',url:'https://jobs.lever.co/employer/REQ-B',state:'needs_you'});
 ctx.store.put('decision',{id:'shared-account',jobId:job.id,jobIds:[job.id,'job-b'],code:'account_consent',scope:'account:synthetic',details:{accountId:'synthetic'},state:'open'});
 ctx.store.put('decision',{id:'uncertain-a',jobId:job.id,jobIds:[job.id],code:'uncertain_submission',scope:'job:'+job.id,state:'open'});
 const p=seedProposal(ctx,job);new OutcomeService({store:ctx.store}).accept(p.id);
 assert.equal(ctx.store.get('decision','shared-account').state,'open');assert.equal(ctx.store.get('job','job-b').state,'needs_you');assert.equal(ctx.store.get('decision','uncertain-a').state,'resolved');
});

test('dismissed mailbox proposals cannot be silently reaccepted by automatic tracking',async t=>{
 const ctx=await setup(t),job=seedJob(ctx),p=seedProposal(ctx,job),outcomes=new OutcomeService({store:ctx.store});outcomes.dismiss(p.id);
 assert.throws(()=>outcomes.accept(p.id,{automatic:true}),e=>e.code==='outcome_review');assert.equal(ctx.store.get('inbox_proposal',p.id).state,'dismissed');assert.equal(ctx.store.get('job',job.id).evidence.length,0);
});

test('the same accepted employer message cannot duplicate evidence or history',async t=>{
 const ctx=await setup(t),job=seedJob(ctx),p=seedProposal(ctx,job),outcomes=new OutcomeService({store:ctx.store});outcomes.accept(p.id);const before=ctx.store.list('event').length;
 assert.equal(outcomes.accept(p.id).replayed,true);assert.equal(ctx.store.get('job',job.id).evidence.length,1);assert.equal(ctx.store.list('event').length,before);
});

test('processing a historical interview before a later historical offer preserves employer event chronology',async t=>{
 const ctx=await setup(t),job=seedJob(ctx),outcomes=new OutcomeService({store:ctx.store});
 const interview=seedProposal(ctx,job,{messageId:'interview-message',proposedOutcome:'interview',evidence:{receivedAt:new Date(Date.now()-20*60000).toISOString(),quote:'Example Employer invites you to an interview for Sensor engineering intern REQ-A.'}});
 outcomes.accept(interview.id);assert.equal(ctx.store.get('job',job.id).state,'interview');
 const offer=seedProposal(ctx,job,{messageId:'offer-message',proposedOutcome:'offer',evidence:{receivedAt:new Date(Date.now()-5*60000).toISOString(),quote:'Example Employer is pleased to offer you Sensor engineering intern REQ-A.'}});
 outcomes.accept(offer.id);assert.equal(ctx.store.get('job',job.id).state,'offer','Processing time is not employer event time');
 assert.equal(ctx.store.get('job',job.id).evidence.length,2);
});

test('verification request reuse preserves the active signup or login purpose',async t=>{
 const ctx=await setup(t,{vault:true}),adapter=new EmployerAccountAdapter({store:ctx.store,vault:ctx.vault});
 await adapter.saveSettings({tenant:'jobs.lever.co/employer',expectedSenders:[sender],allowedHosts:['jobs.lever.co'],expectedSubject:'Verify your account'});
 const publicAccount=await adapter.saveExisting({tenant:'jobs.lever.co/employer',email:candidate.email,password:'synthetic-employer-password'});
 const job=seedJob(ctx),first=adapter.request(ctx.store.get('account',publicAccount.id),job,'signup');
 assert.equal(adapter.request(ctx.store.get('account',publicAccount.id),job,'signup').id,first.id);
 const login=adapter.request(ctx.store.get('account',publicAccount.id),job,'login');
 assert.notEqual(login.id,first.id);assert.equal(login.purpose,'login');assert.equal(ctx.store.get('verification_request',first.id).state,'superseded');
 assert.equal(ctx.store.get('account',publicAccount.id).verificationPurpose,'login');
});

test('an explicitly authorized application alias can receive outcomes, but revoked aliases cannot',async t=>{
 const ctx=await setup(t),job=seedJob(ctx),alias='candidate+intern@example.test';
 ctx.store.put('profile',{...candidate,email:alias});
 const connection=ctx.store.get('connection','inbox');ctx.store.put('connection',{...connection,recipients:[candidate.email,alias]});
 const proposal=seedProposal(ctx,job,{candidateEmail:alias,evidence:{recipient:alias}}),outcomes=new OutcomeService({store:ctx.store});
 outcomes.accept(proposal.id);assert.equal(ctx.store.get('job',job.id).submissionConfirmation,'employer_confirmed');
 const another=seedProposal(ctx,job,{messageId:'revoked-alias-message',candidateEmail:alias,evidence:{recipient:alias}});
 ctx.store.put('connection',{...ctx.store.get('connection','inbox'),recipients:[candidate.email],revision:2});
 assert.throws(()=>outcomes.accept(another.id),e=>e.code==='outcome_review');
});

test('partial or empty account consent answers cannot falsely resolve a multi-question hold',async t=>{
 const ctx=await setup(t,{vault:true}),adapter=new EmployerAccountAdapter({store:ctx.store,vault:ctx.vault});
 await adapter.saveSettings({tenant:'jobs.lever.co/employer',expectedSenders:[sender],allowedHosts:['jobs.lever.co']});
 const a=await adapter.saveExisting({tenant:'jobs.lever.co/employer',email:candidate.email,password:'synthetic-employer-password'}),account=ctx.store.get('account',a.id),job=seedJob(ctx,{state:'needs_you'});
 const questions=[{label:'I agree to employer terms',kind:'consent',required:true},{label:'Send optional account updates',kind:'consent',required:false}].map(q=>({...q,consentHash:consentFingerprint(q.label)}));
 ctx.store.put('decision',{id:'consent-hold',jobId:job.id,jobIds:[job.id],code:'account_consent',state:'open',details:{accountId:account.id,questions}});
 for(const answer of [{},{'I agree to employer terms':true}]){
  assert.throws(()=>adapter.recordConsent(account,questions,answer),e=>e.code==='account_consent');
  assert.equal(ctx.store.get('decision','consent-hold').state,'open');
 }
 adapter.recordConsent(account,questions,{'I agree to employer terms':true,'Send optional account updates':false});
 assert.equal(ctx.store.get('decision','consent-hold').state,'resolved');
 const approvals=adapter.config(account.tenant).consentApprovals;assert.equal(approvals[questions[0].consentHash].answer,true);assert.equal(approvals[questions[1].consentHash].answer,false);
});
