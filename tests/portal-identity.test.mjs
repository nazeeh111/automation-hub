import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJob,importJobs} from '../server/index.mjs';
import {postingIdentity,BrowserAdapter} from '../server/adapters.mjs';
import {tenantKey,accountIdentity} from '../server/accounts.mjs';
import {assessApplicationLimits} from '../server/application-limits.mjs';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';

const board='synthetic-board',requisition='00000000-0000-4000-8000-000000000001';
const url=region=>`https://${region==='eu'?'jobs.eu.lever.co':'jobs.lever.co'}/${board}/${requisition}`;
const legacyIdentity=`main|lever:${board}|${requisition}|`;
const legacyId='job-'+createHash('sha256').update(legacyIdentity).digest('hex').slice(0,24);
async function fixture(t){const directory=await mkdtemp(path.join(tmpdir(),'hub-portal-identity-'));const store=new Store(directory),cleanup=[];t.after(async()=>{for(const close of cleanup)await close();store.close();await rm(directory,{recursive:true,force:true});});return {store,directory,cleanup};}
function oldJob(store,region,extra={}){return store.put('job',{id:legacyId,identity:legacyIdentity,url:url(region),employer:'Example Labs',title:'Engineering intern',state:'uncertain',revision:2,evidence:[],...extra});}
const bytes=(store,kind,id)=>store.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind,id)?.body;

test('Lever region is explicit for both new identities while apply and tracking aliases deduplicate',()=>{
 for(const region of ['us','eu']){
  const first=canonicalJob(url(region));
  assert.match(first.identity,new RegExp(`^main\\|lever:${region}:`));
  assert.notEqual(first.identity,legacyIdentity);
  for(const suffix of ['/apply','/apply/?utm_source=fixture&lever-source=fixture', '?source=fixture#application']){
   assert.equal(canonicalJob(url(region)+suffix).identity,first.identity);
   assert.equal(postingIdentity(url(region)+suffix,'lever'),postingIdentity(url(region),'lever'));
  }
 }
 assert.notEqual(canonicalJob(url('us')).identity,canonicalJob(url('eu')).identity);
 assert.notEqual(postingIdentity(url('us'),'lever'),postingIdentity(url('eu'),'lever'));
 assert.equal(canonicalJob('https://boards.greenhouse.io/example/jobs/123?utm_source=fixture').identity,canonicalJob('https://job-boards.greenhouse.io/example/jobs/123').identity);
});

for(const region of ['us','eu'])test(`legacy ${region} job deduplicates URL aliases without rewriting history or blocking the other region`,async t=>{
 const {store}=await fixture(t),old=oldJob(store,region);
 const run=store.put('run',{id:'old-dispatch',jobId:old.id,identity:old.identity,state:'uncertain',dispatchedAt:'2026-11-14T12:00:00Z'});
 const event=store.event(old.id,'submission_dispatched',{attemptId:run.id});
 store.put('package',{id:'old-package',jobId:old.id,hash:'synthetic-hash'});
 const records=[['job',old.id],['run',run.id],['event',event.id],['package','old-package']];
 const original=records.map(([kind,id])=>bytes(store,kind,id));
 const other=region==='us'?'eu':'us';
 const result=importJobs(store,JSON.stringify([url(region)+'/apply?source=fixture',url(other),url(other)+'/apply?utm_campaign=fixture']));
 assert.deepEqual(result,{imported:1,duplicates:2,errors:[]});
 assert.equal(store.list('job').length,2);
 const added=store.list('job').find(job=>job.id!==old.id);
 assert.equal(added.identity,canonicalJob(url(other)).identity);
 assert.notEqual(added.id,old.id);
 assert.deepEqual(records.map(([kind,id])=>bytes(store,kind,id)),original);
 assert.equal(store.get('run',run.id).identity,legacyIdentity);
 const revision=store.revision();
 assert.deepEqual(importJobs(store,[url(region),url(other)].join('\n')),{imported:0,duplicates:2,errors:[]});
 assert.equal(store.revision(),revision);
});

test('new regional deterministic IDs remain stable after reopening the actual SQLite store',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-regional-restart-'));let store=new Store(directory);
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 assert.deepEqual(importJobs(store,[url('us'),url('eu')].join('\n')),{imported:2,duplicates:0,errors:[]});
 const original=store.list('job');assert.notEqual(original[0].id,original[1].id);
 store.close();store=new Store(directory);
 assert.deepEqual(importJobs(store,[url('eu')+'/apply',url('us')+'?ref=fixture'].join('\n')),{imported:0,duplicates:2,errors:[]});
 assert.deepEqual(store.list('job'),original);
});

test('actual adapter inspection rejects a redirect between regions before reading the destination posting',async()=>{
 const adapter=new BrowserAdapter();let closed=0,bodyReads=0;
 adapter.open=async()=>({portal:'lever',context:{},page:{url:()=>url('eu'),locator:selector=>({count:async()=>0,innerText:async()=>{bodyReads++;return selector;}})}});
 adapter.closeContext=async()=>{closed++;};
 await assert.rejects(adapter.inspect({url:url('us')}),error=>error.code==='posting_identity');
 assert.equal(bodyReads,0);assert.equal(closed,1);
});

test('employer limit evidence cannot bind a US job to an identically numbered EU posting',()=>{
 const quote='Applicants may submit a maximum of two applications to Example Labs.';
 const job={id:'current',identity:canonicalJob(url('us')).identity,url:url('us'),title:'Engineering intern',employer:'Example Labs',state:'imported',posting:{title:'Engineering intern',employer:'Example Labs',text:quote,sourceUrl:url('eu'),sourceHash:'synthetic-posting',open:true,observedAt:'2026-11-14T12:00:00Z'}};
 const report=assessApplicationLimits({job,profile:{id:'main'},jobs:[job],userCap:3});
 assert.equal(report.confirmed.length,0);assert.equal(report.needsReview,true);
 assert.equal(report.ambiguous[0].reason,'posting_identity_or_source_unverified');
 const valid={...job,posting:{...job.posting,sourceUrl:url('us')+'/apply'}};
 assert.equal(assessApplicationLimits({job:valid,profile:{id:'main'},jobs:[valid],userCap:3}).confirmed[0].cap,2);
});

test('existing account and verification tenant keys already separate Lever regional hosts',()=>{
 assert.notEqual(tenantKey(url('us')),tenantKey(url('eu')));
 assert.notEqual(accountIdentity(url('us'),'main'),accountIdentity(url('eu'),'main'));
 assert.equal(tenantKey(url('us')+'/apply'),tenantKey(url('us')));
});

for(const region of ['us','eu'])test(`legacy ${region} dispatched history still blocks a second submit after URL deduplication`,async t=>{
 const {store,directory,cleanup}=await fixture(t);let submissions=0;
 const engine=new Engine({store,directory,adapter:{inspect:async job=>job.posting,submit:async()=>{submissions++;return {status:'uncertain'};},close:async()=>{}},resumes:{assertPackageCurrent:()=>{}}});
 cleanup.push(()=>engine.stop());
 store.put('profile',{...store.get('profile','main'),fullName:'Synthetic Candidate',email:'synthetic@example.test'});
 store.put('resume',{id:'synthetic-resume',mega:false});
 const job=oldJob(store,region,{state:'ready',packageId:'synthetic-package',posting:{title:'Engineering intern',employer:'Example Labs',text:'Engineering internship. Python preferred.',requirements:[],sourceUrl:url(region),sourceHash:'synthetic-posting',open:true}});
 store.put('package',{id:job.packageId,jobId:job.id,verified:true,approved:true,requirements:[]});
 const run=store.put('run',{id:'old-dispatch',jobId:job.id,identity:job.identity,state:'uncertain',dispatchedAt:'2026-11-14T12:00:00Z'});
 const original=bytes(store,'run',run.id);
 assert.equal(importJobs(store,url(region)+'/apply?utm_source=fixture').duplicates,1);
 await engine.action('savePolicy',{rules:{allowedHosts:['jobs.lever.co','jobs.eu.lever.co'],maxApplications:10,maxPerEmployer:3}});
 const campaign=await engine.action('enableCampaign',{confirmed:true});
 await engine.apply(store.get('job',job.id),campaign);
 assert.equal(submissions,0);
 assert(store.list('decision').some(decision=>decision.jobId===job.id&&decision.code==='uncertain_submission'));
 assert.equal(bytes(store,'run',run.id),original);
 assert.equal(store.get('job',job.id).identity,legacyIdentity);
});

