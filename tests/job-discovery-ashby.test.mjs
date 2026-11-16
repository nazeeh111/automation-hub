import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {JobDiscovery,parseDiscoverySource,DISCOVERY_LIMITS} from '../server/job-discovery.mjs';
import {createHub} from '../server/index.mjs';

const id='00000000-0000-4000-8000-000000000001';
const posting=(extra={})=>({id,title:'Engineering placement',location:'Boston, MA',address:{postalAddress:{addressCountry:'USA'}},secondaryLocations:[],employmentType:'Intern',workplaceType:'Hybrid',isRemote:true,isListed:true,department:'Engineering',team:'Platform',descriptionPlain:'Synthetic engineering internship. Python preferred.',publishedAt:'2026-11-16T12:00:00Z',jobUrl:`https://jobs.ashbyhq.com/example/${id}`,applyUrl:`https://jobs.ashbyhq.com/example/${id}/application`,...extra});
async function fixture(t,options={}){
 const directory=await mkdtemp(join(tmpdir(),'hub-ashby-discovery-')),store=new Store(directory);let time=Date.parse('2026-11-16T12:00:00Z'),data={apiVersion:'1',jobs:[posting()]},status=200;const calls=[];
 const discovery=new JobDiscovery({store,clock:()=>time,minIntervalMs:1,staleMs:1000,resolver:async()=>[{address:'93.184.216.34',family:4}],fetcher:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify(data),{status});},...options});
 const source=discovery.registerSource({boardUrl:'https://jobs.ashbyhq.com/example',label:'Example'});
 t.after(async()=>{discovery.close();store.close();await rm(directory,{recursive:true,force:true});});
 return {store,discovery,source,calls,setData:value=>data=value,setStatus:value=>status=value,advance:()=>time+=2000};
}

test('Ashby exact board registration permits no account or arbitrary API destinations',()=>{
 assert.deepEqual(parseDiscoverySource('https://jobs.ashbyhq.com/example'),{id:'ashby:global:example',provider:'ashby',region:'global',board:'example',boardUrl:'https://jobs.ashbyhq.com/example'});
 for(const url of ['https://jobs.ashbyhq.com/example/job-id','https://api.ashbyhq.com/posting-api/job-board/example','https://jobs.ashbyhq.com/example?secret=x','https://jobs.ashbyhq.com.evil.test/example','https://user:pass@jobs.ashbyhq.com/example'])assert.throws(()=>parseDiscoverySource(url),e=>e.code==='DISCOVERY_SOURCE');
});

test('Ashby fixed public GET maps Intern, exact hosted role, hybrid and last publication honestly',async t=>{
 const f=await fixture(t);assert.equal(f.calls.length,0);await f.discovery.refresh(f.source.id);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].url,'https://api.ashbyhq.com/posting-api/job-board/example');assert.equal(f.calls[0].init.method,'GET');assert.equal(f.calls[0].init.credentials,'omit');
 const result=f.discovery.snapshot({provider:'ashby',usOnly:true,roleType:'intern'});assert.equal(result.total,1);
 const row=result.candidates[0];assert.equal(row.externalId,id);assert.equal(row.workplaceType,'hybrid');assert.equal(row.employmentType,'Intern');assert.equal(row.country,'USA');assert.equal(row.locationScope,'us');assert.equal(row.postedAt,null);assert.equal(row.sourceUpdatedAt,'2026-11-16T12:00:00.000Z');assert.equal(row.publishedAtMeaning,'last_published');assert.equal(row.supportStatus,'external_portal');assert.match(row.supportDetail,/manual/i);assert.equal(row.queueEligible,true);
 assert.equal(f.discovery.candidateForQueue(row.id).url,posting().jobUrl);assert.equal(f.store.list('job').length,0);assert.equal(f.store.get('campaign','main').enabled,false);
});

test('unlisted Ashby roles are excluded and missing/secondary geography stays conservative',async t=>{
 const f=await fixture(t);f.setData({apiVersion:'1',jobs:[posting(),posting({id:'hidden',jobUrl:'https://jobs.ashbyhq.com/example/hidden',isListed:false}),posting({id:'unknown',jobUrl:'https://jobs.ashbyhq.com/example/unknown',location:'Remote',address:{},workplaceType:'Remote'}),posting({id:'mixed',jobUrl:'https://jobs.ashbyhq.com/example/mixed',secondaryLocations:[{location:'Toronto',address:{addressCountry:'Canada'}}]}),posting({id:'nested',jobUrl:'https://jobs.ashbyhq.com/example/nested',secondaryLocations:[{location:'New York',address:{postalAddress:{addressCountry:'USA'}}}]})]});
 await f.discovery.refresh(f.source.id);const result=f.discovery.snapshot();assert.equal(result.total,4);assert.equal(result.sources[0].coverage,'complete');
 assert.equal(result.candidates.find(row=>row.externalId==='unknown').locationScope,'unknown');const mixed=result.candidates.find(row=>row.externalId==='mixed');assert.equal(mixed.locationScope,'unknown');assert.match(mixed.location,/Toronto/);assert.equal(mixed.locations[1].country,'Canada');assert.equal(result.candidates.find(row=>row.externalId==='nested').locationScope,'us');assert.equal(f.discovery.snapshot({usOnly:true}).total,2);
});

test('Ashby disappearance, stale reads, server failure and over-size response preserve saves without queue authority',async t=>{
 const f=await fixture(t);await f.discovery.refresh(f.source.id);const row=f.discovery.snapshot().candidates[0];f.discovery.setFavorite(row.id,true);
 f.advance();assert.equal(f.discovery.snapshot().candidates[0].availability,'unknown');assert.throws(()=>f.discovery.candidateForQueue(row.id),e=>e.code==='DISCOVERY_REFRESH_REQUIRED');
 f.setData({apiVersion:'1',jobs:[]});await f.discovery.refresh(f.source.id);assert.equal(f.discovery.snapshot().candidates[0].availability,'missing');
 f.advance();f.setStatus(503);await assert.rejects(f.discovery.refresh(f.source.id),e=>e.code==='DISCOVERY_UNAVAILABLE');assert.equal(f.discovery.snapshot().candidates[0].favorite,true);assert.equal(f.discovery.snapshot().candidates[0].availability,'unknown');
 f.advance();const before=f.store.list('discovery_candidate');f.discovery.fetcher=async()=>new Response('{}',{headers:{'Content-Length':String(DISCOVERY_LIMITS.responseBytes+1)}});await assert.rejects(f.discovery.refresh(f.source.id),e=>e.code==='DISCOVERY_RESPONSE_LIMIT');assert.deepEqual(f.store.list('discovery_candidate'),before);
});

test('malformed Ashby API versions, duplicate IDs and cross-employer URLs cannot replace retained snapshots',async t=>{
 const f=await fixture(t);await f.discovery.refresh(f.source.id);const before=f.store.list('discovery_candidate');
 for(const data of [{apiVersion:'2',jobs:[posting()]},{apiVersion:'1',jobs:[posting(),posting()]},{apiVersion:'1',jobs:[posting({jobUrl:`https://jobs.ashbyhq.com/other/${id}`})]},{apiVersion:'1',jobs:[posting({id:'not-the-url-id'})]},{apiVersion:'1',jobs:[posting({isListed:undefined})]}]){f.advance();f.setData(data);await assert.rejects(f.discovery.refresh(f.source.id));assert.deepEqual(f.store.list('discovery_candidate'),before);}
});

test('Ashby API queue selection remains local, idempotent and explicitly unsupported for auto-apply',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'hub-ashby-api-'));const hub=await createHub({directory,port:0,discoveryOptions:{resolver:async()=>[{address:'93.184.216.34',family:4}],fetcher:async()=>new Response(JSON.stringify({apiVersion:'1',jobs:[posting()]}))}});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const request=async(route,body)=>{const response=await fetch(hub.baseUrl+route,{method:body?'POST':'GET',headers:{Cookie:cookie,...(body?{Origin:hub.baseUrl,'Content-Type':'application/json','X-Hub-Workspace':'real'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json()};};
 const source=await request('/api/action',{action:'discoveryRegisterSource',boardUrl:'https://jobs.ashbyhq.com/example'});assert.equal(source.status,200);
 assert.equal((await request('/api/action',{action:'discoveryRefresh',sourceId:source.data.id})).status,200);
 const list=await request('/api/discovery?provider=ashby&usOnly=true&roleType=intern');assert.equal(list.status,200);assert.equal(list.data.total,1);const candidate=list.data.candidates[0];
 const first=await request('/api/action',{action:'discoveryQueue',candidateId:candidate.id});assert.equal(first.status,200);assert.equal(first.data.imported,1);
 const second=await request('/api/action',{action:'discoveryQueue',candidateId:candidate.id});assert.equal(second.data.jobId,first.data.jobId);assert.equal(second.data.duplicates,1);
 const store=hub.context(false).store;assert.equal(store.get('job',first.data.jobId).portal,'unsupported');assert.equal(store.get('campaign','main').enabled,false);assert.equal(store.list('run').length,0);
});
