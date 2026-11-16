import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {createHub} from '../server/index.mjs';

// Regression: AI-BACKEND-001 — a role's durable history outlives the global latest 150.
// Found by /qa on 2026-11-16.
// Report: docs/ai-automation-pass-2026-11-16/backend/REPORT.md
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-job-events-')),hub=await createHub({directory,port:0});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const request=async(route,{body,workspace='real',authenticated=true}={})=>{
  const response=await fetch(hub.baseUrl+route,{method:body?'POST':'GET',headers:{...(authenticated?{Cookie:cookie}:{}),'X-Hub-Workspace':workspace,...(body?{Origin:hub.baseUrl,'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
  return {status:response.status,body:await response.json()};
 };
 return {hub,directory,request,store:hub.context(false).store};
}
const addJob=(store,id,extra={})=>store.put('job',{id,identity:`main|synthetic|${id}|`,title:'Synthetic intern',employer:'Example',state:'imported',revision:0,...extra});
const eventsUrl=(id,query='')=>`/api/jobs/${encodeURIComponent(id)}/events${query?'?'+query:''}`;

test('all old-job history remains available after more than 150 other-job events and is scrubbed',async t=>{
 const f=await fixture(t),job=addJob(f.store,'older-role');
 for(let i=0;i<65;i++)f.store.put('event',{id:`old-${i}`,applicationId:job.id,type:'package_prepared',payload:{message:`Older event ${i}`,originalPath:'/private/synthetic/source.pdf',nested:{password:'synthetic-do-not-return',detail:'kept'}},at:'2026-11-15T12:00:00Z'});
 const unrelated=addJob(f.store,'other-role');for(let i=0;i<180;i++)f.store.event(unrelated.id,'other_job_event',{i});
 const state=await f.request('/api/state');assert.equal(state.status,200);assert.equal(state.body.events.filter(event=>event.applicationId===job.id).length,0);
 const first=await f.request(eventsUrl(job.id));assert.equal(first.status,200);assert.equal(first.body.events.length,30);assert.equal(first.body.hasMore,true);assert.equal(typeof first.body.nextCursor,'string');assert.equal(first.body.events[0].id,'old-64');
 assert(!JSON.stringify(first.body).includes('/private/synthetic'));assert(!JSON.stringify(first.body).includes('synthetic-do-not-return'));assert.equal(first.body.events[0].payload.nested.detail,'kept');
 const collected=[...first.body.events];let cursor=first.body.nextCursor;
 // Newer arrivals between pages cannot shift or duplicate the older range.
 f.store.event(job.id,'newer_after_page',{message:'New arrival'});
 while(cursor){const page=await f.request(eventsUrl(job.id,new URLSearchParams({before:cursor,limit:'30'})));assert.equal(page.status,200);collected.push(...page.body.events);assert.equal(page.body.hasMore,Boolean(page.body.nextCursor));cursor=page.body.nextCursor;}
 assert.equal(collected.length,65);assert.equal(new Set(collected.map(event=>event.id)).size,65);assert.deepEqual(collected.map(event=>event.id),Array.from({length:65},(_,i)=>`old-${64-i}`));
});

test('job event paging is a bounded SQL read rather than loading all event documents',async t=>{
 const f=await fixture(t),job=addJob(f.store,'bounded');for(let i=0;i<110;i++)f.store.event(job.id,'fixture',{i});
 const list=f.store.list.bind(f.store);f.store.list=kind=>{assert.notEqual(kind,'event','Per-job events must not load the global event corpus');return list(kind);};
 const result=await f.request(eventsUrl(job.id,'limit=100'));assert.equal(result.status,200);assert.equal(result.body.events.length,100);assert.equal(result.body.hasMore,true);
});

test('event cursor remains stable after closing and reopening the actual store with tied timestamps',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-job-event-restart-'));let store=new Store(directory);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const job=addJob(store,'restart-role');for(let i=0;i<8;i++)store.put('event',{id:`event-${i}`,applicationId:job.id,type:'fixture',payload:{i},at:'2026-11-15T12:00:00Z'});
 const first=store.applicationEvents(job.id,{limit:3});assert.deepEqual(first.events.map(event=>event.id),['event-7','event-6','event-5']);assert.equal(first.hasMore,true);
 store.close();store=new Store(directory);store.event(job.id,'newer',{});
 const second=store.applicationEvents(job.id,{limit:3,before:first.nextCursor});assert.deepEqual(second.events.map(event=>event.id),['event-4','event-3','event-2']);
 const last=store.applicationEvents(job.id,{limit:3,before:second.nextCursor});assert.deepEqual(last.events.map(event=>event.id),['event-1','event-0']);assert.equal(last.hasMore,false);assert.equal(last.nextCursor,null);
});

test('history endpoint rejects invalid authentication, limits, parameters, jobs and cursors without writes',async t=>{
 const f=await fixture(t),job=addJob(f.store,'request-validation');f.store.event(job.id,'fixture',{});f.store.event(job.id,'fixture',{});
 assert.equal((await f.request(eventsUrl(job.id),{authenticated:false})).status,401);
 assert.equal((await f.request(eventsUrl('missing'))).status,404);
 const revision=f.store.revision();
 for(const query of ['limit=0','limit=101','limit=-1','limit=1.2','limit=x','limit=1&limit=2','kind=profile','before=','before=%','before=garbage','before=e30'])assert.equal((await f.request(eventsUrl(job.id,query))).status,400,query);
 assert.equal((await f.request(eventsUrl(job.id),{workspace:''})).status,400);
 assert.equal((await f.request(eventsUrl(job.id),{workspace:'fixture'})).status,409);
 assert.equal(f.store.revision(),revision);
 const first=await f.request(eventsUrl(job.id,'limit=1')),other=addJob(f.store,'different-role');f.store.event(other.id,'fixture',{});
 assert.equal((await f.request(eventsUrl(other.id,new URLSearchParams({before:first.body.nextCursor})))).status,400);
 const decoded=JSON.parse(Buffer.from(first.body.nextCursor,'base64url').toString());decoded.sequence=1;
 assert.equal((await f.request(eventsUrl(job.id,new URLSearchParams({before:Buffer.from(JSON.stringify(decoded)).toString('base64url')})))).status,400);
});

test('arbitrary job identifiers are SQL-bound and event pages never cross real and fixture stores',async t=>{
 const f=await fixture(t),id="synthetic / résumé ' OR 1=1 -- ?%#";addJob(f.store,id);f.store.event(id,'real_history',{message:'only real'});f.store.event(id,'real_history',{message:'older real'});
 const first=await f.request(eventsUrl(id,'limit=1'));assert.equal(first.status,200);assert.equal(first.body.events[0].type,'real_history');
 const fixtureStore=f.hub.context(true).store;addJob(fixtureStore,id);fixtureStore.event(id,'fixture_history',{message:'only fixture'});
 assert.equal((await f.request('/api/demo',{body:{enabled:true}})).status,200);
 const stale=await f.request(eventsUrl(id));assert.equal(stale.status,409);assert.equal(stale.body.code,'WORKSPACE_CHANGED');
 const current=await f.request(eventsUrl(id),{workspace:'fixture'});assert.equal(current.status,200);assert.deepEqual(current.body.events.map(event=>event.type),['fixture_history']);
 assert.equal((await f.request(eventsUrl(id,new URLSearchParams({before:first.body.nextCursor})),{workspace:'fixture'})).status,400);
});

test('explicit ledger export includes retained writing, supporting-file metadata and usage while scrubbing private fields',async t=>{
 const f=await fixture(t),job=addJob(f.store,'exported-role');
 f.store.put('writingDraft',{id:'retained-writing',jobId:job.id,answer:'Synthetic source-backed draft',approved:false,originalPath:'/private/writing',nested:{apiToken:'synthetic-not-for-export',source:'retained'}});
 f.store.put('supportingDocument',{id:'retained-support',jobId:job.id,name:'Synthetic transcript.pdf',hash:'synthetic-hash',originalPath:'/private/support.pdf',binding:{jobIdentity:job.identity,candidateId:'main',questionHash:'synthetic-question'}});
 f.store.put('usage',{id:'model',calls:2,recentAttempts:[{id:'attempt-1',purpose:'resume',status:'returned',startedAt:'2026-11-16T12:00:00Z',endedAt:'2026-11-16T12:00:01Z',outcomeCode:'output_returned'}],nested:{password:'synthetic-never-export'}});
 const revision=f.store.revision(),result=await f.request('/api/export');assert.equal(result.status,200);
 assert.equal(result.body.writingDraft[0].id,'retained-writing');assert.equal(result.body.writingDraft[0].answer,'Synthetic source-backed draft');
 assert.equal(result.body.supportingDocument[0].binding.jobIdentity,job.identity);assert.equal(result.body.usage[0].recentAttempts[0].id,'attempt-1');
 assert(!JSON.stringify(result.body).includes('/private/'));assert(!JSON.stringify(result.body).includes('synthetic-not-for-export'));assert(!JSON.stringify(result.body).includes('synthetic-never-export'));
 assert.equal(f.store.revision(),revision);
});

test('state exposes reasoning projection and a denied second worker cannot mark an active receipt interrupted',async t=>{
 const f=await fixture(t);f.store.put('usage',{id:'model',calls:1,recentAttempts:[{id:'active-receipt',purpose:'resume',status:'running',startedAt:'2026-11-16T12:00:00Z'}]});
 const original=f.store.get('usage','model');
 await assert.rejects(createHub({directory:f.directory,port:0}),/Another hub worker/);assert.deepEqual(f.store.get('usage','model'),original);
 const result=await f.request('/api/state');assert.equal(result.status,200);assert.equal(result.body.reasoning.usedCalls,1);assert.equal(result.body.reasoning.recentAttempts[0].status,'running');
});

test('successful owner acquisition reconciles unfinished reasoning metadata after a genuine restart',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-model-owner-recovery-'));let hub=await createHub({directory,port:0});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const first=hub.context(false).store;first.put('usage',{id:'model',calls:3,recentAttempts:[{id:'interrupted-receipt',purpose:'writing',status:'running',startedAt:'2026-11-16T12:00:00Z'}]});
 await hub.close();hub=await createHub({directory,port:0});const current=hub.context(false).store.get('usage','model');
 assert.equal(current.calls,3);assert.equal(current.recentAttempts[0].status,'interrupted');assert.equal(current.recentAttempts[0].outcomeCode,'service_restarted');assert.equal(hub.context(false).model.snapshot().usedCalls,3);
});

test('bounded global activity preserves the exact prior insertion order without loading all event bodies',async t=>{
 const f=await fixture(t),job=addJob(f.store,'global-events');
 for(let i=0;i<350;i++)f.store.put('event',{id:`global-${i}`,applicationId:i%2?job.id:null,type:'fixture',payload:{i},at:'2026-11-16T12:00:00Z'});
 const expected=f.store.list('event').slice(-150).reverse();assert.deepEqual(f.store.latestEvents(),expected);
 assert.deepEqual(f.store.latestEvents(5),expected.slice(0,5));
 const list=f.store.list.bind(f.store);f.store.list=kind=>{assert.notEqual(kind,'event','State must not load all event bodies');return list(kind);};
 const result=await f.request('/api/state');assert.equal(result.status,200);assert.deepEqual(result.body.events,expected);
});

test('legacy jobId events retain the old inspector fallback, primary binding and restart pagination without rewritten history',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-legacy-job-events-'));let store=new Store(directory);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const legacy=addJob(store,'legacy-role'),primary=addJob(store,'primary-role');
 for(let i=0;i<7;i++)store.put('event',{id:`legacy-${i}`,jobId:legacy.id,...(i%3===0?{applicationId:null}:i%3===1?{applicationId:''}:{}),type:'legacy_fixture',payload:{i},at:'2026-11-15T12:00:00Z'});
 store.put('event',{id:'primary-wins',applicationId:primary.id,jobId:legacy.id,type:'primary_fixture',payload:{},at:'2026-11-15T12:00:00Z'});
 const original=store.list('event'),bytes=store.db.prepare("SELECT body FROM documents WHERE kind='event' ORDER BY rowid").all().map(row=>row.body);
 const expected=original.filter(event=>(event.applicationId||event.jobId)===legacy.id).reverse();
 const first=store.applicationEvents(legacy.id,{limit:3});assert.deepEqual(first.events,expected.slice(0,3));assert.equal(first.hasMore,true);
 assert.deepEqual(store.applicationEvents(primary.id).events.map(event=>event.id),['primary-wins']);
 store.close();store=new Store(directory);
 const second=store.applicationEvents(legacy.id,{limit:3,before:first.nextCursor});const last=store.applicationEvents(legacy.id,{limit:3,before:second.nextCursor});
 assert.deepEqual([...first.events,...second.events,...last.events],expected);assert.equal(last.hasMore,false);assert.equal(last.nextCursor,null);
 assert.deepEqual(store.db.prepare("SELECT body FROM documents WHERE kind='event' ORDER BY rowid").all().map(row=>row.body),bytes);
});

test('the authenticated API exposes legacy-only jobId events for their exact application',async t=>{
 const f=await fixture(t),job=addJob(f.store,'legacy-api'),other=addJob(f.store,'legacy-api-other');
 f.store.put('event',{id:'legacy-api-event',jobId:job.id,type:'legacy_fixture',payload:{},at:'2026-11-15T12:00:00Z'});
 f.store.put('event',{id:'legacy-api-conflict',applicationId:other.id,jobId:job.id,type:'legacy_conflict',payload:{},at:'2026-11-15T12:00:00Z'});
 const result=await f.request(eventsUrl(job.id));assert.equal(result.status,200);assert.deepEqual(result.body.events.map(event=>event.id),['legacy-api-event']);
});

test('legacy JSON object or numeric references cannot be coerced into string application identities',async t=>{
 const f=await fixture(t);addJob(f.store,'123');addJob(f.store,'{"scope":"other"}');
 f.store.put('event',{id:'numeric-primary',applicationId:123,jobId:'123',type:'invalid_scope',payload:{}});
 f.store.put('event',{id:'object-primary',applicationId:{scope:'other'},jobId:'123',type:'invalid_scope',payload:{}});
 f.store.put('event',{id:'object-fallback',jobId:{scope:'other'},type:'invalid_scope',payload:{}});
 assert.deepEqual(f.store.applicationEvents('123').events,[]);assert.deepEqual(f.store.applicationEvents('{"scope":"other"}').events,[]);
});
