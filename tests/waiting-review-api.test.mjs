import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-waiting-api-'));let externalCalls=0;
 const hub=await createHub({directory,port:0,open:false,engineAdapter:{inspect:async()=>{externalCalls++;throw new Error('No external inspection belongs to this local review');},submit:async()=>{externalCalls++;throw new Error('No dispatch belongs to this local review');},close:async()=>{},readiness:async()=>({id:'test-browser',status:'ready'})}});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const ctx=hub.context(false);clearInterval(ctx.engine.timer);ctx.engine.timer=null;
 const auth=await fetch(hub.launchUrl,{redirect:'manual'});assert.equal(auth.status,303);const cookie=auth.headers.get('set-cookie').split(';')[0],base=new URL(hub.launchUrl).origin;
 const request=async(route,headers={})=>fetch(base+route,{headers:{Cookie:cookie,...headers}});
 const now=Date.now(),deadline=new Date(now+20*3600000).toISOString();
 const job=ctx.store.put('job',{id:'waiting-job',identity:'main|lever:us:synthetic|waiting-role|',url:'https://jobs.lever.co/synthetic/waiting-role',employer:'Synthetic Employer',title:'Synthetic intern',state:'uncertain',revision:3,deadline,deadlineUncertain:false,deadlineLabel:'Saved precise application deadline',nextAction:'Reconcile employer evidence',posting:{sourceHash:'saved-posting',sourceUrl:'https://jobs.lever.co/synthetic/waiting-role'},activeAttemptId:'saved-dispatch'});
 const decision=ctx.store.put('decision',{id:'waiting-decision',jobId:job.id,jobIds:[job.id],code:'uncertain_submission',title:'Reconcile this saved attempt',state:'open',createdAt:new Date(now-8*86400000).toISOString(),details:{privateFixtureText:'question-and-answer-authority-must-not-be-copied'}});
 ctx.store.put('run',{id:job.activeAttemptId,jobId:job.id,identity:job.identity,state:'uncertain',dispatchedAt:new Date(now-86400000).toISOString()});ctx.store.put('package',{id:'saved-package',jobId:job.id,hash:'retained-package-hash',approved:true});
 const bytes=()=>['job','decision','run','package'].map(kind=>ctx.store.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY id').all(kind).map(row=>row.body));
 return {ctx,request,job,decision,bytes,externalCalls:()=>externalCalls};
}

test('existing worker publishes local attention through actual state ETag and export without mutating authority',async t=>{
 const f=await fixture(t),original=f.bytes(),before=await f.request('/api/state');assert.equal(before.status,200);const etag=before.headers.get('etag');assert.equal((await before.json()).decisions[0].attention,undefined);
 assert.deepEqual(await f.ctx.engine.tick(),{idle:true});
 const changed=await f.request('/api/state',{'If-None-Match':etag});assert.equal(changed.status,200);assert.notEqual(changed.headers.get('etag'),etag);
 const state=await changed.json(),decision=state.decisions.find(item=>item.id===f.decision.id);assert.equal(decision.attention.level,'saved_deadline_24h');assert.match(decision.attention.reason,/not been rechecked/);assert.equal(state.jobs[0].state,'uncertain');assert.equal(state.campaign.enabled,false);assert.equal(state.summary.confirmed,0);
 assert.deepEqual(f.bytes(),original);assert.equal(f.externalCalls(),0);
 const sidecar=f.ctx.store.get('decision_attention',f.decision.id);assert(sidecar);assert(!JSON.stringify(sidecar).includes('question-and-answer-authority-must-not-be-copied'));
 const exported=await f.request('/api/export');assert.equal(exported.status,200);const data=await exported.json();assert.equal(data.decision_attention.length,1);assert.equal(data.decision_attention[0].id,f.decision.id);assert.deepEqual(data.decision[0],f.ctx.store.get('decision',f.decision.id));assert.equal(data.decision[0].attention,undefined);
 const revision=f.ctx.store.revision();await f.ctx.engine.tick();assert.equal(f.ctx.store.revision(),revision);assert.equal((await f.request('/api/state',{'If-None-Match':changed.headers.get('etag')})).status,304);
});

test('actual state projection rejects stale attention before another tick after source change or resolution',async t=>{
 const f=await fixture(t);await f.ctx.engine.tick();assert((await(await f.request('/api/state')).json()).decisions[0].attention);
 f.ctx.store.put('job',{...f.ctx.store.get('job',f.job.id),deadline:new Date(Date.now()+12*86400000).toISOString(),posting:{...f.job.posting,sourceHash:'new-posting'},revision:4});
 assert.equal((await(await f.request('/api/state')).json()).decisions[0].attention,undefined);
 f.ctx.store.put('decision',{...f.ctx.store.get('decision',f.decision.id),state:'resolved',resolvedAt:new Date().toISOString()});
 assert.equal((await(await f.request('/api/state')).json()).decisions[0].attention,undefined);assert(f.ctx.store.get('decision_attention',f.decision.id),'Old attention remains historical, without being projected');assert.equal(f.ctx.store.get('run',f.job.activeAttemptId).state,'uncertain');assert.equal(f.externalCalls(),0);
});

test('active verification expiry invalidates the actual state ETag without rewriting request authority',async t=>{
 const f=await fixture(t),started=Date.now();let clock=started;
 const originalProjection=f.ctx.connections.activeVerificationRequests.bind(f.ctx.connections);f.ctx.connections.activeVerificationRequests=()=>originalProjection({now:clock});
 for(const [id,expiresAt] of [['fresh',new Date(started+60000).toISOString()],['expired',new Date(started-1000).toISOString()],['malformed','not-a-time'],['ambiguous','2026-11-15']])f.ctx.store.put('verification_request',{id,state:'pending',tenant:'synthetic-employer',recipient:'synthetic@example.invalid',purpose:'login',expiresAt,credentialRef:'never-project-this-reference'});
 const requestBytes=()=>f.ctx.store.db.prepare("SELECT body FROM documents WHERE kind='verification_request' ORDER BY id").all().map(row=>row.body),original=requestBytes();
 const response=await f.request('/api/state'),etag=response.headers.get('etag');assert.equal(response.status,200);const state=await response.json();assert.deepEqual(state.verificationRequests.map(request=>request.id),['fresh']);assert.equal(state.summary.needsYou,2);assert(!JSON.stringify(state.verificationRequests).includes('never-project-this-reference'));
 assert.equal((await f.request('/api/state',{'If-None-Match':etag})).status,304);const revision=f.ctx.store.revision();clock+=60000;
 const expired=await f.request('/api/state',{'If-None-Match':etag});assert.equal(expired.status,200);assert.notEqual(expired.headers.get('etag'),etag);const expiredState=await expired.json();assert.deepEqual(expiredState.verificationRequests,[]);assert.equal(expiredState.summary.needsYou,1);assert.equal(f.ctx.store.revision(),revision);assert.deepEqual(requestBytes(),original);assert.equal(f.externalCalls(),0);
 assert.equal((await f.request('/api/state',{'If-None-Match':expired.headers.get('etag')})).status,304);
});
