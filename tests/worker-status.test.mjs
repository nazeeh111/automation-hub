import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {createHub} from '../server/index.mjs';

// Regression: outer scheduler failures were consumed without observable diagnostics.
// Found by /qa on 2026-11-16. Report: docs/ai-automation-pass-2026-11-16/research/worker-status/REPORT.md
// Value: protects=observable scheduler failures and pure workspace-bound snapshots; fails_when=errors vanish or reads mutate; why_new=no worker diagnostics boundary; seam=none; no_claim=live employer behavior.
async function fixture(t,{adapter,intervalMs=2000}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-worker-status-')),store=new Store(directory);
 const engine=new Engine({store,directory,resumes:{},adapter:adapter||{close:async()=>{}},intervalMs});
 t.after(async()=>{await engine.stop();store.close();await rm(directory,{recursive:true,force:true});});
 return {store,engine};
}
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Expected worker diagnostics within the bounded observation');}

test('worker diagnostics distinguish unobserved, idle, paused and stopped without ledger writes',async t=>{
 const {store,engine}=await fixture(t),initial=engine.runtimeStatus();
 assert.equal(initial.lastTickStartedAt,null);assert.equal(initial.lastTickCompletedAt,null);assert.equal(initial.lastErrorCode,null);assert.equal(initial.scheduled,false);assert.equal(initial.busy,false);assert.equal(initial.stopped,false);
 const before=store.revision();assert.deepEqual(await engine.tick(),{idle:true});assert.equal(store.revision(),before);
 const idle=engine.runtimeStatus();assert.ok(Date.parse(idle.lastTickStartedAt));assert.ok(Date.parse(idle.lastTickCompletedAt));assert.equal(idle.activePhase,null);
 store.put('campaign',{...store.get('campaign','main'),status:'paused'});const pausedRevision=store.revision();await engine.tick();assert.equal(store.revision(),pausedRevision);assert.equal(engine.runtimeStatus().lastErrorCode,null);
 await engine.stop();const stopped=engine.runtimeStatus();assert.equal(stopped.stopping,true);assert.equal(stopped.stopped,true);assert.equal(stopped.scheduled,false);assert.equal(stopped.busy,false);
 const retained=stopped.lastTickCompletedAt;await engine.tick();assert.equal(engine.runtimeStatus().lastTickCompletedAt,retained);assert.equal(store.get('campaign','main').status,'paused');
});

test('an outer tick rejection stays rejected and retains a constant private error receipt after recovery',async t=>{
 const {store,engine}=await fixture(t),original=store.list.bind(store),failure=Object.assign(new Error('PRIVATE_SYNTHETIC_MESSAGE'),{code:'PRIVATE_SYNTHETIC_CODE'});
 store.list=kind=>{if(kind==='job')throw failure;return original(kind);};
 await assert.rejects(engine.tick(),error=>error===failure);
 const failed=engine.runtimeStatus();assert.equal(failed.lastErrorCode,'WORKER_TICK_FAILED');assert.ok(Date.parse(failed.lastErrorAt));assert.equal(failed.lastTickCompletedAt,null);assert(!JSON.stringify(failed).includes('PRIVATE_SYNTHETIC'));
 store.list=original;await engine.tick();const recovered=engine.runtimeStatus();assert.equal(recovered.lastErrorAt,failed.lastErrorAt);assert.equal(recovered.lastErrorCode,'WORKER_TICK_FAILED');assert.ok(Date.parse(recovered.lastTickCompletedAt)>=Date.parse(failed.lastErrorAt));assert.equal(recovered.busy,false);
 const detached=engine.runtimeStatus();detached.lastErrorCode='changed';assert.equal(engine.runtimeStatus().lastErrorCode,'WORKER_TICK_FAILED');
});

test('overlapping busy ticks retain the actual long operation rather than reporting it idle',async t=>{
 let entered,release;const started=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);t.after(()=>release?.());
 const {store,engine}=await fixture(t,{adapter:{inspect:async()=>{entered();await held;return {open:false,title:'Synthetic role',employer:'Synthetic employer',text:'This synthetic role is closed.',sourceHash:'synthetic-closed-source',sourceUrl:'https://jobs.lever.co/synthetic/long'};},close:async()=>{release();}}});
 store.put('job',{id:'long-job',identity:'synthetic-long',url:'https://jobs.lever.co/synthetic/long',title:'Synthetic role',employer:'Synthetic employer',state:'imported',preparationRequested:true,revision:0});
 const work=engine.tick();await started;const active=engine.runtimeStatus();assert.equal(active.busy,true);assert.equal(active.activePhase,'prepare');assert.equal(active.activeJobId,'long-job');assert.ok(Date.parse(active.activeStartedAt));
 assert.deepEqual(await engine.tick(),{busy:true});const overlap=engine.runtimeStatus();assert.equal(overlap.busy,true);assert.equal(overlap.activePhase,'prepare');assert.equal(overlap.activeJobId,'long-job');assert.equal(overlap.activeStartedAt,active.activeStartedAt);
 release();assert.deepEqual(await work,{closed:true});const done=engine.runtimeStatus();assert.equal(done.busy,false);assert.equal(done.activePhase,null);assert.equal(done.activeJobId,null);assert.equal(done.activeStartedAt,null);assert.equal(done.lastErrorCode,null);assert.equal(store.get('job','long-job').state,'closed');assert.equal(store.list('run').length,0);
});

test('the existing scheduled callback records failures and keeps the loop available for later checks',async t=>{
 const {store,engine}=await fixture(t,{intervalMs:5}),original=store.list.bind(store);
 store.list=kind=>{if(kind==='job')throw new Error('PRIVATE_SCHEDULE_FAILURE');return original(kind);};engine.start();
 await until(()=>engine.runtimeStatus().lastErrorCode==='WORKER_TICK_FAILED');assert.equal(engine.runtimeStatus().scheduled,true);
 store.list=original;await until(()=>Boolean(engine.runtimeStatus().lastTickCompletedAt));assert.equal(engine.runtimeStatus().lastErrorCode,'WORKER_TICK_FAILED');assert.equal(engine.runtimeStatus().busy,false);await engine.stop();assert.equal(engine.runtimeStatus().scheduled,false);
});

async function apiFixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-worker-status-api-'));let calls=0;
 const hub=await createHub({directory,port:0,modelRunner:async()=>{calls++;throw new Error('Inference is forbidden by this fixture');},discoveryOptions:{fetcher:async()=>{calls++;throw new Error('External feeds are forbidden by this fixture');}}});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];const request=async(route,{workspace='real',authenticated=true,headers={}}={})=>fetch(hub.baseUrl+route,{headers:{...(authenticated?{Cookie:cookie}:{}),...(workspace===null?{}:{'X-Hub-Workspace':workspace}),...headers}});
 return {hub,request,cookie,calls:()=>calls};
}
test('runtime GET requires authenticated exact-workspace binding and reads only diagnostics',async t=>{
 const {hub,request,calls}=await apiFixture(t),ctx=hub.context(false);
 const stateBefore=await request('/api/state'),etag=stateBefore.headers.get('etag');assert.ok(etag);await stateBefore.arrayBuffer();await ctx.engine.tick();await ctx.engine.stop({releaseWorker:false});const revision=ctx.store.revision();
 assert.equal((await request('/api/runtime',{authenticated:false})).status,401);
 for(const workspace of [null,'invalid'])assert.equal((await request('/api/runtime',{workspace})).status,400);
 const mismatch=await request('/api/runtime',{workspace:'fixture'});assert.equal(mismatch.status,409);assert.equal((await mismatch.json()).code,'WORKSPACE_CHANGED');
 for(const query of ['?limit=1','?mode=real','?observedAt=x&observedAt=y'])assert.equal((await request('/api/runtime'+query)).status,400);
 const response=await request('/api/runtime'),value=await response.json();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('etag'),null);assert.ok(Date.parse(value.observedAt));assert.equal(value.engine.workerId,ctx.engine.ownerId);assert.equal(value.engine.stopped,true);assert.equal(value.engine.lastErrorCode,null);assert.deepEqual(Object.keys(value).sort(),['engine','observedAt']);
 await request('/api/runtime');const unchanged=await request('/api/state',{headers:{'If-None-Match':etag}});assert.equal(unchanged.status,304);assert.equal(ctx.store.revision(),revision);assert.equal(calls(),0);assert.equal(ctx.store.list('run').length,0);assert.equal(ctx.store.get('campaign','main').enabled,false);
});

test('runtime snapshots bind to the chosen workspace and never fall back to the other worker',async t=>{
 const {hub,request,cookie,calls}=await apiFixture(t),real=hub.context(false);await real.engine.stop({releaseWorker:false});
 const changed=await fetch(hub.baseUrl+'/api/demo',{method:'POST',headers:{Cookie:cookie,Origin:hub.baseUrl,'Content-Type':'application/json','X-Hub-Workspace':'real'},body:JSON.stringify({enabled:true})});assert.equal(changed.status,200);
 const fixtureContext=hub.context(true);await fixtureContext.engine.stop({releaseWorker:false});const revision=fixtureContext.store.revision();
 assert.equal((await request('/api/runtime')).status,409);const result=await request('/api/runtime',{workspace:'fixture'});assert.equal(result.status,200);const data=await result.json();assert.equal(data.engine.workerId,fixtureContext.engine.ownerId);assert.notEqual(data.engine.workerId,real.engine.ownerId);assert.equal(fixtureContext.store.revision(),revision);assert.equal(calls(),0);
});
