import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';
import {postingJob} from './fixtures/posting.mjs';

// Regression: workflow atomicity — failed selection and answer saves must retain
// the preceding active document/question together with their authority.
// Found by /qa on 2026-11-17
// Report: docs/final-run-2026-11-17/workflows/REPORT.md
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-workflow-atomicity-'));let submissions=0,models=0;
 const hub=await createHub({directory,port:0,open:false,modelRunner:async()=>{models++;throw Error('Forbidden inference');},engineAdapter:{readiness:async()=>({id:'browser',status:'limited'}),inspect:async job=>job.posting,close:async()=>{},submit:async()=>{submissions++;throw Error('Forbidden dispatch');}},discoveryOptions:{fetcher:async()=>{throw Error('Forbidden external read');}}});
 const ctx=hub.context(false),store=ctx.store;clearInterval(ctx.engine.timer);ctx.engine.timer=null;
 t.after(async()=>{try{assert.equal(submissions,0);assert.equal(models,0);assert.equal(store.list('run').length,0);assert.equal(store.get('campaign','main').enabled,false);}finally{await hub.close();await rm(directory,{recursive:true,force:true});}});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const request=async(endpoint,body)=>{const response=await fetch(hub.baseUrl+endpoint,{method:'POST',headers:{Cookie:cookie,Origin:hub.baseUrl,'X-Hub-Workspace':'real','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:response.status,value:await response.json()};};
 const action=body=>request('/api/action',body);assert.equal((await action({action:'saveProfile',profile:{fullName:'Synthetic Candidate',email:'synthetic@example.invalid'}})).status,200);
 const snapshot=()=>Object.fromEntries(['job','package','decision','postingObservation','event'].map(kind=>[kind,store.list(kind)]));
 return {hub,ctx,store,request,action,snapshot};
}
async function selectable(t){
 const f=await fixture(t),files=['First','Replacement'].map(name=>({name:name+'.md',content:Buffer.from('# Synthetic Candidate\n\n## Projects\n### '+name+' controlled prototype\n- Built a simulated Python sensor in controlled tests.\n\n## Skills\nPython\n').toString('base64')}));
 assert.equal((await f.request('/api/import/resumes',{files})).value.imported,2);const [first,second]=f.store.list('resume');
 postingJob(f.store,{id:'role',title:'Engineering intern',employer:'Synthetic Labs'});assert.equal((await f.action({action:'selectResume',jobId:'role',resumeId:first.id})).status,200);
 assert.equal((await f.action({action:'reviewPackage',packageId:f.store.get('job','role').packageId,approved:true})).status,200);
 return {...f,first,second,job:()=>f.store.get('job','role')};
}
for(const phase of ['final_selection','package_event'])test(`replacement ${phase} failure preserves active document, source, approval and reviews`,async t=>{
 const f=await selectable(t);f.ctx.engine.hold(f.job(),'form_questions','Keep this employer question open',{questions:[{label:'Start date',name:'start',kind:'answer',type:'text',required:true,sourceUrl:f.job().url}]});const before=f.snapshot(),old=f.store.get('package',f.job().packageId),oldBytes=await readFile(old.finalPath),put=f.store.put.bind(f.store);let injected=false;
 f.store.put=(kind,value)=>{if(!injected&&(phase==='final_selection'?kind==='job'&&value.selectedResumeId===f.second.id:kind==='event'&&value.type==='package_prepared')){injected=true;throw Error('Synthetic '+phase+' persistence failure');}return put(kind,value);};
 let failed;try{failed=await f.action({action:'selectResume',jobId:'role',resumeId:f.second.id});}finally{f.store.put=put;}
 assert(injected);assert.equal(failed.status,400);const after=f.snapshot();for(const kind of ['package','decision','postingObservation','event'])assert.deepEqual(after[kind],before[kind],kind);
 for(const field of ['packageId','selectedResumeId','posting','postingObservationId','latestPostingObservationId','postingLastCheckedAt','state'])assert.deepEqual(f.job()[field],before.job[0][field],field);
 assert.deepEqual(await readFile(old.finalPath),oldBytes);assert.equal(f.store.get('package',old.id).approved,true);
 const recovered=await f.action({action:'selectResume',jobId:'role',resumeId:f.second.id});assert.equal(recovered.status,200);assert.equal(f.job().selectedResumeId,f.second.id);assert.equal(f.store.get('package',f.job().packageId).resumeId,f.second.id);assert.equal(f.store.get('package',f.job().packageId).approved,false);
});
test('queued selection and changed-source question settle together or leave the prior selection untouched',async t=>{
 const f=await selectable(t);f.ctx.engine.postings.record(f.job(),{...f.job().posting,text:'A newer synthetic posting.',sourceHash:'new-synthetic-source'},{reason:'pre_dispatch'});const decision=f.ctx.engine.hold(f.job(),'posting_changed','Review the changed source',f.ctx.engine.postings.changeDetails(f.job())),before=f.snapshot(),revision=f.store.revision(),put=f.store.put.bind(f.store);let injected=false;
 f.store.put=(kind,value)=>{if(!injected&&kind==='decision'&&value.id===decision.id&&value.state==='resolved'){injected=true;throw Error('Synthetic queued-selection review persistence failure');}return put(kind,value);};
 let failed;try{failed=await f.action({action:'selectResume',jobId:'role',resumeId:f.second.id});}finally{f.store.put=put;}
 assert(injected);assert.equal(failed.status,400);assert.deepEqual(f.snapshot(),before);assert.equal(f.store.revision(),revision);assert.equal((await f.action({action:'selectResume',jobId:'role',resumeId:f.second.id})).status,200);assert.equal(f.job().selectedResumeId,f.second.id);assert.equal(f.job().packageId,before.job[0].packageId);assert.equal(f.store.get('decision',decision.id).state,'resolved');
});
test('takeover while replacement renders preserves the old active package and publishes no staged package',async t=>{
 const f=await selectable(t),before=f.snapshot(),select=f.ctx.resumes.select.bind(f.ctx.resumes);let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
 f.ctx.resumes.select=async(...args)=>{const pkg=await select(...args);enter();await gate;return pkg;};t.after(()=>release());
 const pending=f.action({action:'selectResume',jobId:'role',resumeId:f.second.id});await entered;assert.equal((await f.action({action:'takeover',jobId:'role'})).status,200);const manual=f.job();release();assert.equal((await pending).status,409);assert.deepEqual(f.job(),manual);
 for(const kind of ['package','decision','postingObservation','event'])assert.deepEqual(f.snapshot()[kind],before[kind],kind);assert.equal(f.job().packageId,before.job[0].packageId);assert.equal(f.job().selectedResumeId,f.first.id);
});
test('competing replacement selection rejects without effects and the original request publishes one current package',async t=>{
 const f=await selectable(t),select=f.ctx.resumes.select.bind(f.ctx.resumes);let enter,release;const entered=new Promise(resolve=>enter=resolve),gate=new Promise(resolve=>release=resolve);
 f.ctx.resumes.select=async(...args)=>{const pkg=await select(...args);enter();await gate;return pkg;};t.after(()=>release());
 const pending=f.action({action:'selectResume',jobId:'role',resumeId:f.second.id});await entered;const before=f.snapshot(),revision=f.store.revision();assert.equal((await f.action({action:'selectResume',jobId:'role',resumeId:f.first.id})).status,409);assert.deepEqual(f.snapshot(),before);assert.equal(f.store.revision(),revision);
 release();assert.equal((await pending).status,200);assert.equal(f.job().selectedResumeId,f.second.id);assert.equal(f.store.list('package').length,2);assert.equal(f.store.list('event').filter(e=>e.type==='package_prepared').length,2);
});
async function questioned(t){
 const f=await fixture(t);let job=postingJob(f.store,{id:'role',packageId:'retained-package',state:'ready'});f.store.put('package',{id:'retained-package',jobId:job.id,verified:true,approved:true,hash:'synthetic-question-only'});
 const label='Available start date',decision=f.ctx.engine.hold(job,'form_questions','Answer current employer question',{questions:[{label,name:'start',kind:'answer',type:'text',tag:'input',required:true,sourceUrl:job.url}]});return {...f,label,decision};
}
for(const phase of ['decision','event'])test(`employer-answer ${phase} persistence failure rolls back question, answer, execution state and history`,async t=>{
 const f=await questioned(t),before=f.snapshot(),revision=f.store.revision(),put=f.store.put.bind(f.store);let injected=false;
 f.store.put=(kind,value)=>{if(!injected&&(phase==='decision'?kind==='decision'&&value.id===f.decision.id&&value.state==='resolved':kind==='event'&&value.type==='decision_resolved')){injected=true;throw Error('Synthetic question '+phase+' persistence failure');}return put(kind,value);};
 let failed;try{failed=await f.action({action:'resolveDecision',decisionId:f.decision.id,answer:{[f.label]:'June 2027'}});}finally{f.store.put=put;}
 assert(injected);assert.equal(failed.status,400);assert.deepEqual(f.snapshot(),before);assert.equal(f.store.revision(),revision);assert.equal(f.store.get('job','role').state,'needs_you');assert.equal(f.store.get('job','role').answers,undefined);
 assert.equal((await f.action({action:'resolveDecision',decisionId:f.decision.id,answer:{[f.label]:'July 2027'}})).status,200);assert.equal(f.store.get('job','role').answers[f.label],'July 2027');assert.equal(f.store.get('decision',f.decision.id).state,'resolved');assert.equal(f.store.list('event').filter(e=>e.type==='decision_resolved').length,1);
});
test('invalid employer answer and superseded question cannot alter saved execution state',async t=>{
 const f=await questioned(t),before=f.snapshot(),revision=f.store.revision();assert.equal((await f.action({action:'resolveDecision',decisionId:f.decision.id,answer:{}})).status,400);assert.deepEqual(f.snapshot(),before);assert.equal(f.store.revision(),revision);
 f.store.put('decision',{...f.decision,state:'superseded'});const superseded=f.snapshot(),supersededRevision=f.store.revision();assert.equal((await f.action({action:'resolveDecision',decisionId:f.decision.id,answer:{[f.label]:'June 2027'}})).status,409);assert.deepEqual(f.snapshot(),superseded);assert.equal(f.store.revision(),supersededRevision);
});
test('overlapping employer-answer requests settle once and a later answer cannot replace the first saved answer',async t=>{
 const f=await questioned(t),first=f.action({action:'resolveDecision',decisionId:f.decision.id,answer:{[f.label]:'June 2027'}}),second=f.action({action:'resolveDecision',decisionId:f.decision.id,answer:{[f.label]:'July 2027'}});const results=await Promise.all([first,second]);assert(results.every(r=>r.status===200));
 const saved=f.store.get('decision',f.decision.id);assert(['June 2027','July 2027'].includes(saved.answer[f.label]));assert.equal(f.store.get('job','role').answers[f.label],saved.answer[f.label]);assert.equal(f.store.list('event').filter(e=>e.type==='decision_resolved').length,1);
 const before=f.snapshot(),revision=f.store.revision();assert.equal((await f.action({action:'resolveDecision',decisionId:f.decision.id,answer:{[f.label]:'August 2027'}})).status,200);assert.deepEqual(f.snapshot(),before);assert.equal(f.store.revision(),revision);
});
