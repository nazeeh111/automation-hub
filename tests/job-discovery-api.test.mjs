import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub,canonicalJob,importJobs} from '../server/index.mjs';

async function fixture(t){
 let time=Date.now(),calls=0,unavailable=false;
 const rows=Array.from({length:145},(_,i)=>({id:i+1,title:i===144?'Rare photonics internship':`Engineering intern ${i+1}`,absolute_url:`https://job-boards.greenhouse.io/example/jobs/${i+1}`,content:'Synthetic academic research role',location:{name:'Remote'}}));
 const directory=await mkdtemp(path.join(tmpdir(),'hub-discovery-api-'));
 const hub=await createHub({directory,port:0,discoveryOptions:{clock:()=>time,minIntervalMs:1,staleMs:1000,resolver:async()=>[{address:'93.184.216.34',family:4}],fetcher:async(url,options)=>{calls++;assert.equal(options.method,'GET');assert.equal(new URL(url).hostname,'boards-api.greenhouse.io');return new Response(JSON.stringify({jobs:rows,meta:{total:rows.length}}),{status:unavailable?503:200});}}});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const request=async(route,body,headers={})=>{const response=await fetch(hub.baseUrl+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{Origin:hub.baseUrl,'Content-Type':'application/json','X-Hub-Workspace':'real'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,etag:response.headers.get('etag'),data:response.status===304?null:await response.json()};};
 return {hub,request,rows,advance:()=>time+=2000,fail:()=>unavailable=true,calls:()=>calls};
}
async function source(request){const result=await request('/api/action',{action:'discoveryRegisterSource',boardUrl:'https://boards.greenhouse.io/example',label:'Example'});assert.equal(result.status,200);return result.data;}
test('discovery API searches all records before paging, keeps saves separate and selects exactly one canonical job',async t=>{
 const f=await fixture(t),s=await source(f.request);assert.equal(f.calls(),0);
 assert.equal((await f.request('/api/action',{action:'discoveryRefresh',sourceId:s.id})).status,200);assert.equal(f.calls(),1);
 const metadata=(await f.request('/api/state')).data;assert.equal(metadata.discovery.total,145);assert.equal(metadata.discovery.usInternshipsTotal,0);assert.deepEqual(metadata.discovery.candidates,[]);assert.equal(metadata.jobs.length,0);assert.equal(metadata.campaign.enabled,false);
 const page=await f.request('/api/discovery?limit=40&offset=120');assert.equal(page.data.total,145);assert.equal(page.data.candidates.length,25);
 const us=await f.request('/api/discovery?usOnly=true');assert.equal(us.data.total,0);const unknown=await f.request('/api/discovery?locationScope=unknown');assert.equal(unknown.data.total,145);
 const search=await f.request('/api/discovery?query=photonics');assert.equal(search.data.total,1);const candidate=search.data.candidates[0];
 const saved=await f.request('/api/action',{action:'discoveryFavorite',candidateId:candidate.id,favorite:true});assert.equal(saved.status,200);assert.equal((await f.request('/api/discovery?favoriteOnly=true')).data.total,1);assert.equal(f.hub.context(false).store.list('job').length,0);
 const queued=await f.request('/api/action',{action:'discoveryQueue',candidateId:candidate.id});assert.equal(queued.data.queued,true);assert.equal(queued.data.imported,1);
 const again=await f.request('/api/action',{action:'discoveryQueue',candidateId:candidate.id});assert.equal(again.data.queued,true);assert.equal(again.data.jobId,queued.data.jobId);assert.equal(again.data.duplicates,1);
 const job=f.hub.context(false).store.get('job',queued.data.jobId);assert.equal(job.discoveryCandidateId,candidate.id);assert.equal(job.state,'imported');assert.equal(job.identityConfirmed,false);assert.equal(job.submissionConfirmation,undefined);assert.equal(f.hub.context(false).store.get('campaign','main').enabled,false);
 const exported=(await f.request('/api/export')).data;assert.equal(exported.discovery_source.length,1);assert.equal(exported.discovery_candidate.length,145);assert.equal(exported.discovery_favorite.length,1);
});
test('time-sensitive discovery metadata invalidates conditional state; failed reads preserve dated saves and block queueing',async t=>{
 const f=await fixture(t),s=await source(f.request);await f.request('/api/action',{action:'discoveryRefresh',sourceId:s.id});const first=await f.request('/api/state');assert.equal((await f.request('/api/state',undefined,{'If-None-Match':first.etag})).status,304);
 const id=(await f.request('/api/discovery')).data.candidates[0].id;await f.request('/api/action',{action:'discoveryFavorite',candidateId:id,favorite:true});const before=await f.request('/api/state');f.advance();
 const stale=await f.request('/api/state',undefined,{'If-None-Match':before.etag});assert.equal(stale.status,200);assert.equal(stale.data.discovery.sources[0].status,'stale');assert.equal((await f.request('/api/action',{action:'discoveryQueue',candidateId:id})).status,409);
 f.fail();assert.equal((await f.request('/api/action',{action:'discoveryRefresh',sourceId:s.id})).status,409);const saved=(await f.request('/api/discovery?favoriteOnly=true')).data;assert.equal(saved.total,1);assert.equal(saved.candidates[0].availability,'unknown');assert.equal(saved.candidates[0].queueEligible,false);assert.equal(f.hub.context(false).store.list('job').length,0);
});
test('discovery filters are bounded and typed; stale workspace actions cannot mutate the other store',async t=>{
 const f=await fixture(t),s=await source(f.request);
 for(const query of ['limit=101','limit=2.5','offset=-1','favoriteOnly=1','provider=ashby','usOnly=yes','locationScope=canada','sort=posted','query=a&query=b','unknown=x'])assert.equal((await f.request('/api/discovery?'+query)).status,400,query);
 assert.equal((await f.request('/api/discovery?limit=0')).data.candidates.length,0);
 const store=f.hub.context(false).store,observedAt=new Date().toISOString();
 store.put('discovery_source',{...store.get('discovery_source',s.id),status:'ready',lastObservedAt:observedAt});
 for(const [id,title,location] of [['intern','Sensor engineering internship','Boston, MA'],['senior','Senior engineer','Boston, MA'],['international','International Tax Manager','Boston, MA'],['unknown','Firmware intern','Remote']])store.put('discovery_candidate',{id,sourceId:s.id,title,company:'Example',location,firstSeenAt:observedAt,lastSeenAt:observedAt,availability:'active'});
 const home=(await f.request('/api/state')).data.discovery;assert.equal(home.total,4);assert.equal(home.usInternshipsTotal,1);assert.equal(home.counters.us,3);

 assert.equal((await f.request('/api/demo',{enabled:true})).status,200);
 assert.equal((await f.request('/api/action',{action:'discoveryRemoveSource',sourceId:s.id})).status,409);assert.equal(f.hub.context(false).store.list('discovery_source').length,1);assert.equal(f.hub.context(true).store.list('discovery_source').length,0);
 assert.equal((await f.request('/api/discovery')).data.total,0);assert.equal(f.calls(),0);
});
test('Greenhouse regional aliases deduplicate legacy URL history without merging US and EU',async t=>{
 const {hub}=await fixture(t),store=hub.context(false).store,url='https://job-boards.eu.greenhouse.io/fideres/jobs/5015510101';
 const legacy={id:'legacy-eu',identity:'main|job-boards.eu.greenhouse.io|/fideres/jobs/5015510101|',url,title:'Historical role',state:'submitted',submissionConfirmation:'candidate_attested',revision:4};store.put('job',legacy);const before=store.get('job',legacy.id);
 assert.equal(importJobs(store,JSON.stringify([{url:url+'?utm_source=example'}])).duplicates,1);assert.deepEqual(store.get('job',legacy.id),before);
 const us='https://boards.greenhouse.io/fideres/jobs/5015510101';assert.notEqual(canonicalJob(url).identity,canonicalJob(us).identity);assert.equal(importJobs(store,JSON.stringify([{url:us}])).imported,1);assert.equal(store.list('job').length,2);
});
