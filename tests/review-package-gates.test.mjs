import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

// This fixture tests scheduling authority, not document rendering or employer acceptance.
async function fixture(t,{state='needs_you',...extra}={}) {
 const directory=await mkdtemp(path.join(tmpdir(),'hub-package-authority-'));let dispatches=0;
 const adapter={inspect:async job=>job.posting,close:async()=>{},submit:async(j,p,k,{beforeDispatch})=>{beforeDispatch();dispatches++;return {status:'uncertain'};}};
 const hub=await createHub({directory,port:0,engineAdapter:adapter});t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const ctx=hub.context(false);clearInterval(ctx.engine.timer);ctx.engine.timer=null;
 const profile=ctx.store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:'synthetic@example.test',answers:{}});
 ctx.store.put('resume',{id:'resume',mega:false});
 ctx.store.put('job',{id:'job',identity:'main|lever:example|role',title:'Engineering intern',employer:'Example Labs',url:'https://jobs.lever.co/example/role',state,revision:0,packageId:'pkg',posting:{title:'Engineering intern',employer:'Example Labs',sourceHash:'synthetic-posting',sourceUrl:'https://jobs.lever.co/example/role',text:'Synthetic engineering internship.',open:true},...extra});
 ctx.store.put('package',{id:'pkg',jobId:'job',resumeId:'resume',verified:true,approved:false,hash:'synthetic-package',profileRevision:profile.updatedAt,finalPath:'/synthetic-not-opened.pdf',requirements:[]});
 ctx.store.put('decision',{id:'review',jobId:'job',code:'package_review',state:'open',details:{packageId:'pkg',hash:'synthetic-package'}});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const action=async body=>{const res=await fetch(hub.baseUrl+'/api/action',{method:'POST',headers:{Cookie:cookie,Origin:hub.baseUrl,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 const saved=()=>['job','package','decision','run'].map(kind=>ctx.store.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY id').all(kind).map(row=>row.body));
 return {...ctx,action,profile,saved,dispatches:()=>dispatches};
}

for(const state of ['submitted','interview','assessment','rejected','offer','closed','cancelled','manual','uncertain','applying','failed','imported','preparing'])test(`document approval cannot reopen ${state} work`,async t=>{
 const f=await fixture(t,{state}),before=f.saved();const res=await f.action({action:'reviewPackage',packageId:'pkg',approved:true});assert.equal(res.status,409);assert.deepEqual(f.saved(),before);assert.equal(f.dispatches(),0);
});
for(const extra of [{priorApplicationDetected:true},...['employer_confirmed','candidate_attested','fixture'].map(submissionConfirmation=>({submissionConfirmation}))])test(`document approval cannot override recorded application ${JSON.stringify(extra)}`,async t=>{
 const f=await fixture(t,{state:'ready',...extra}),before=f.saved();const res=await f.action({action:'reviewPackage',packageId:'pkg',approved:true});assert.equal(res.status,409);assert.deepEqual(f.saved(),before);
});
for(const outcome of ['submitted','interview','assessment','rejected','offer','closed'])test(`actual recorded ${outcome} plus late document approval cannot dispatch again`,async t=>{
 const f=await fixture(t);const result=await f.action({action:'recordOutcome',jobId:'job',outcome,evidence:{url:'https://jobs.lever.co/example/receipt',reference:'synthetic-receipt',employer:'Example Labs',title:'Engineering intern',email:f.profile.email}});assert.equal(result.status,200);const before=f.saved();
 const approval=await f.action({action:'reviewPackage',packageId:'pkg',approved:true});assert.equal(approval.status,409);assert.deepEqual(f.saved(),before);
 assert.equal((await f.action({action:'savePolicy',rules:{maxApplications:10,maxPerEmployer:3,allowedHosts:['jobs.lever.co']}})).status,200);assert.equal((await f.action({action:'enableCampaign',confirmed:true})).status,200);await f.engine.tick();assert.equal(f.dispatches(),0);assert.equal(f.store.get('job','job').state,outcome);assert.equal(f.store.get('package','pkg').approved,false);
});
test('approval only releases the current document review while preserving another open question',async t=>{
 const f=await fixture(t);f.store.put('decision',{id:'question',jobId:'job',code:'form_questions',state:'open',details:{questions:[{label:'Start date'}]}});
 const res=await f.action({action:'reviewPackage',packageId:'pkg',approved:true});assert.equal(res.status,200);assert.equal(f.store.get('package','pkg').approved,true);assert.equal(f.store.get('decision','review').state,'resolved');assert.equal(f.store.get('decision','question').state,'open');assert.equal(f.store.get('job','job').state,'needs_you');assert.equal(f.dispatches(),0);
});
test('a reviewed current package becomes ready and a deliberate decline cannot schedule work',async t=>{
 const f=await fixture(t);assert.equal((await f.action({action:'reviewPackage',packageId:'pkg',approved:true})).status,200);assert.equal(f.store.get('job','job').state,'ready');assert.equal((await f.action({action:'reviewPackage',packageId:'pkg',approved:false})).status,200);assert.equal(f.store.get('package','pkg').approved,false);assert.equal(f.store.get('job','job').state,'needs_you');assert.equal(f.dispatches(),0);
});
for(const approved of ['false','true',1,0,null,{},[]])test(`malformed document approval ${JSON.stringify(approved)} preserves authority`,async t=>{
 const f=await fixture(t),before=f.saved();const res=await f.action({action:'reviewPackage',packageId:'pkg',approved});assert.equal(res.status,400);assert.deepEqual(f.saved(),before);assert.equal(f.dispatches(),0);
});

// Both public approval routes must preserve authority when review context changes.
const approveDecision=f=>f.action({action:'resolveDecision',decisionId:'review',answer:'approve'});
for(const state of ['submitted','interview','assessment','rejected','offer','closed','cancelled','manual','uncertain','applying','failed','imported','preparing'])test(`decision approval cannot reopen ${state} work`,async t=>{
 const f=await fixture(t,{state}),before=f.saved();assert.equal((await approveDecision(f)).status,409);assert.deepEqual(f.saved(),before);assert.equal(f.dispatches(),0);
});
for(const route of ['reviewPackage','resolveDecision']){
 const approve=f=>route==='reviewPackage'?f.action({action:route,packageId:'pkg',approved:true}):approveDecision(f);
 test(`${route} refuses a candidate changed after the retained document`,async t=>{
  const f=await fixture(t);f.store.put('profile',{...f.profile,updatedAt:undefined,location:'Changed candidate location'});
  // Fix a deterministic new revision without relying on the wall clock tick.
  f.store.db.prepare("UPDATE documents SET body=json_set(body,'$.updatedAt',?) WHERE kind='profile' AND id='main'").run('2099-01-01T00:00:00.000Z');
  const before=f.saved();assert.equal((await approve(f)).status,409);assert.deepEqual(f.saved(),before);assert.equal(f.dispatches(),0);
 });
 test(`${route} refuses a document retaining a rejected source fact`,async t=>{
  const f=await fixture(t);f.store.put('fact',{id:'fact',text:'Built a simulated sensor prototype.',conflict:true,sources:[{resumeId:'resume'}]});const pkg=f.store.get('package','pkg');f.store.put('package',{...pkg,text:'Built a simulated sensor prototype.',sources:[{factId:'fact',quote:'Built a simulated sensor prototype.'}]});
  const before=f.saved();assert.equal((await approve(f)).status,409);assert.deepEqual(f.saved(),before);
 });
 test(`${route} preserves another exact employer question after document approval`,async t=>{
  const f=await fixture(t);f.store.put('decision',{id:'question',jobId:'job',code:'form_questions',state:'open',title:'Confirm your start date',details:{questions:[{label:'Start date'}]}});
  assert.equal((await approve(f)).status,200);assert.equal(f.store.get('package','pkg').approved,true);assert.equal(f.store.get('decision','review').state,'resolved');assert.equal(f.store.get('decision','question').state,'open');assert.equal(f.store.get('job','job').state,'needs_you');assert.equal(f.store.get('job','job').nextAction,'Confirm your start date');
 });
 test(`${route} cannot schedule a retained dispatched attempt even if the visible state is waiting`,async t=>{
  const f=await fixture(t);f.store.put('run',{id:'attempt',jobId:'job',state:'dispatched',dispatchedAt:new Date().toISOString()});f.store.put('job',{...f.store.get('job','job'),activeAttemptId:'attempt'});
  const before=f.saved();assert.equal((await approve(f)).status,409);assert.deepEqual(f.saved(),before);assert.equal(f.dispatches(),0);
 });
}
for(const details of [{packageId:'older',hash:'synthetic-package'},{packageId:'pkg',hash:'old-hash'},{}])test(`decision approval refuses obsolete exact-version binding ${JSON.stringify(details)}`,async t=>{
 const f=await fixture(t);f.store.put('decision',{...f.store.get('decision','review'),details});const before=f.saved();assert.equal((await approveDecision(f)).status,409);assert.deepEqual(f.saved(),before);
});
test('a current exact document decision approves once without campaign enablement',async t=>{
 const f=await fixture(t);assert.equal((await approveDecision(f)).status,200);assert.equal(f.store.get('package','pkg').approved,true);assert.equal(f.store.get('job','job').state,'ready');assert.equal(f.store.get('campaign','main').enabled,false);const before=f.saved();assert.equal((await approveDecision(f)).status,200);assert.deepEqual(f.saved(),before);assert.equal(f.dispatches(),0);
});
