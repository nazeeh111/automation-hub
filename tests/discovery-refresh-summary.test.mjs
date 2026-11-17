import '../server/runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.mjs';
import {JobDiscovery,DISCOVERY_LIMITS} from '../server/job-discovery.mjs';

const posting=(id,extra={})=>({id,title:`Engineering intern ${id}`,location:{name:'Boston, MA'},absolute_url:`https://job-boards.greenhouse.io/acme/jobs/${id}`,content:'<p>Build instruments.</p>',...extra});
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'hub-refresh-summary-')),store=new Store(directory);
 let time=Date.parse('2026-11-17T06:00:00Z'),jobs=[posting(1),posting(2)],total=2,status=200;
 const discovery=new JobDiscovery({store,clock:()=>time,minIntervalMs:1,resolver:async()=>[{address:'93.184.216.34',family:4}],fetcher:async()=>new Response(JSON.stringify({jobs,...(total===null?{}:{meta:{total}})}),{status})});
 const source=discovery.registerSource({boardUrl:'https://job-boards.greenhouse.io/acme',label:'Acme'});
 t.after(async()=>{discovery.close();store.close();await rm(directory,{recursive:true,force:true});});
 return {store,discovery,source,set:(rows,count=rows.length)=>{jobs=rows;total=count;},status:value=>{status=value;},refresh:async(id=source.id)=>{time+=2;return (await discovery.refresh(id)).lastRefreshSummary;}};
}
const counts=(baseline=0,added=0,changed=0,seenAgain=0,noLongerListed=null)=>({baseline,new:added,changed,seenAgain,noLongerListed});

test('first committed source snapshot is a baseline; later observations partition new, changed and seen again',async t=>{
 const f=await fixture(t),first=await f.refresh();
 assert.equal(first.version,1);assert.equal(first.sourceId,f.source.id);assert.equal(first.baseline,true);assert.equal(first.coverage,'complete');assert.equal(first.observedCount,2);assert.equal(first.previousObservedAt,null);assert.deepEqual(first.counts,counts(2));
 f.set([posting(1),posting(2,{content:'Build satellites.'}),posting(3)]);
 const second=await f.refresh();assert.equal(second.baseline,false);assert.equal(second.previousObservedAt,first.observedAt);assert.notEqual(second.observedAt,first.observedAt);assert.deepEqual(second.counts,counts(0,1,1,1,0));assert.equal(second.observedCount,second.counts.new+second.counts.changed+second.counts.seenAgain);
 assert.deepEqual(f.discovery.snapshot().sources[0].lastRefreshSummary,second);assert.equal(f.store.list('job').length,0);assert.equal(f.store.get('campaign','main').enabled,false);
});

test('timestamp, source-label, favorite and queue changes cannot masquerade as posting edits',async t=>{
 const f=await fixture(t);await f.refresh();const id=f.source.id+':1';f.discovery.setFavorite(id,true);
 f.store.put('job',{id:'unrelated-queued-role',identity:'manual-role',state:'imported'});
 f.discovery.registerSource({boardUrl:f.source.boardUrl,label:'My employer label'});
 f.set([posting(1,{updated_at:'2026-11-17T18:00:00Z',first_published:'2026-11-17T17:00:00Z'}),posting(2)]);
 const receipt=await f.refresh();assert.deepEqual(receipt.counts,counts(0,0,0,2,0));assert.equal(f.discovery.snapshot({favoriteOnly:true}).candidates[0].favorite,true);assert.equal(f.store.get('job','unrelated-queued-role').state,'imported');
});

test('partial coverage cannot count absence; complete coverage counts only newly absent rows',async t=>{
 const f=await fixture(t);await f.refresh();f.set([posting(1)],4);const partial=await f.refresh();assert.equal(partial.coverage,'partial');assert.deepEqual(partial.counts,counts(0,0,0,1,null));assert.equal(f.store.get('discovery_candidate',f.source.id+':2').availability,'active');
 f.set([posting(1),posting(3)]);const complete=await f.refresh();assert.deepEqual(complete.counts,counts(0,1,0,1,1));assert.equal(f.store.get('discovery_candidate',f.source.id+':2').availability,'missing');
 assert.deepEqual((await f.refresh()).counts,counts(0,0,0,2,0));
 f.set([posting(1),posting(2),posting(3)]);assert.deepEqual((await f.refresh()).counts,counts(0,0,0,3,0));
 f.set([posting(1),posting(3)]);assert.equal((await f.refresh()).counts.noLongerListed,1);
});

test('a partial first observation remains an explicit baseline and a missing total never counts absence',async t=>{
 const f=await fixture(t);f.set([posting(1)],null);const first=await f.refresh();assert.equal(first.baseline,true);assert.equal(first.coverage,'partial');assert.deepEqual(first.counts,counts(1));f.set([],null);assert.deepEqual((await f.refresh()).counts,counts(0,0,0,0,null));
});

test('unavailable and rate-limited checks retain the exact earlier successful receipt',async t=>{
 const f=await fixture(t),first=await f.refresh();for(const status of [503,429]){f.status(status);await assert.rejects(f.refresh());const source=f.discovery.snapshot().sources[0];assert.equal(source.status,'unavailable');assert.deepEqual(source.lastRefreshSummary,first);assert.equal(source.lastRefreshSummary.observedAt,source.lastObservedAt);assert.notEqual(source.lastAttemptAt,first.observedAt);}
});

test('metadata-only fallback and restored description coverage do not establish a description change',async t=>{
 const f=await fixture(t);await f.refresh();let metadata=true;
 f.discovery.fetcher=async url=>metadata&&new URL(url).search?new Response('{}',{headers:{'Content-Length':String(DISCOVERY_LIMITS.responseBytes+1)}}):new Response(JSON.stringify({jobs:[posting(1,{content:metadata?undefined:'Newly readable text.'}),posting(2,{content:metadata?undefined:'Also readable.'})],meta:{total:2}}));
 const fallback=await f.refresh();assert.deepEqual(fallback.counts,counts(0,0,0,2,0));assert.equal(f.discovery.snapshot().sources[0].descriptionCoverage,'metadata_only');
 metadata=false;assert.deepEqual((await f.refresh()).counts,counts(0,0,0,2,0));
 f.discovery.fetcher=async()=>new Response(JSON.stringify({jobs:[posting(1,{content:'An actual later edit.'}),posting(2,{content:'Also readable.'})],meta:{total:2}}));assert.deepEqual((await f.refresh()).counts,counts(0,0,1,1,0));
});

test('same external ID in another source cannot affect this source receipt or candidates',async t=>{
 const f=await fixture(t),first=await f.refresh(),other=f.discovery.registerSource({boardUrl:'https://job-boards.greenhouse.io/other',label:'Other'});
 f.set([posting(1,{absolute_url:'https://job-boards.greenhouse.io/other/jobs/1'})]);const otherReceipt=await f.refresh(other.id);assert.deepEqual(otherReceipt.counts,counts(1));assert.equal(otherReceipt.sourceId,other.id);assert.deepEqual(f.store.get('discovery_source',f.source.id).lastRefreshSummary,first);assert.equal(f.store.get('discovery_candidate',f.source.id+':2').availability,'active');
});

test('source relabel or removal during an awaited read revokes the late receipt without restoring old configuration',async t=>{
 for(const change of ['label','remove']){
  const f=await fixture(t),first=await f.refresh();let release;const gate=new Promise(resolve=>{release=resolve;});f.discovery.fetcher=async()=>{await gate;return new Response(JSON.stringify({jobs:[posting(3)],meta:{total:1}}));};
  const pending=f.refresh();await new Promise(resolve=>setImmediate(resolve));if(change==='label')f.discovery.registerSource({boardUrl:f.source.boardUrl,label:'Replacement label'});else f.discovery.removeSource(f.source.id);release();await assert.rejects(pending,e=>e.code==='DISCOVERY_REVOKED');
  const source=f.store.get('discovery_source',f.source.id);if(change==='label'){assert.equal(source.label,'Replacement label');assert.deepEqual(source.lastRefreshSummary,first);}else assert.equal(source,null);assert.equal(f.store.get('discovery_candidate',f.source.id+':3'),null);
 }
});

test('candidate or source write failure rolls back delta and candidates together; subsequent refresh recovers',async t=>{
 for(const failureKind of ['discovery_candidate','discovery_source']){
  const f=await fixture(t),first=await f.refresh(),before=f.store.list('discovery_candidate'),put=f.store.put.bind(f.store);let injected=false;
  f.set([posting(1,{content:'Changed text.'}),posting(3)]);f.store.put=(kind,document)=>{if(!injected&&kind===failureKind&&(kind!=='discovery_source'||document.lastRefreshSummary?.observedAt!==first.observedAt)){injected=true;throw new Error('synthetic storage failure');}return put(kind,document);};
  await assert.rejects(f.refresh(),e=>e.code==='DISCOVERY_UNAVAILABLE');assert.equal(injected,true);assert.deepEqual(f.store.list('discovery_candidate'),before);assert.deepEqual(f.store.get('discovery_source',f.source.id).lastRefreshSummary,first);
  f.store.put=put;assert.deepEqual((await f.refresh()).counts,counts(0,1,1,0,1));
 }
});

test('receipt is constant-size for large boards and reconnected sources establish a fresh baseline',async t=>{
 const f=await fixture(t);f.set(Array.from({length:800},(_,i)=>posting(i+1)));const first=await f.refresh();assert.deepEqual(first.counts,counts(800));assert(JSON.stringify(first).length<500);assert.equal('examples' in first,false);
 f.discovery.removeSource(f.source.id);f.discovery.registerSource({boardUrl:f.source.boardUrl,label:'Reconnected'});f.set([posting(1)]);const reconnected=await f.refresh();assert.equal(reconnected.baseline,true);assert.equal(reconnected.previousObservedAt,null);assert.deepEqual(reconnected.counts,counts(1));assert.equal(f.store.list('discovery_candidate').length,800);
});

test('legacy observed sources use retained content without inventing an earlier receipt',async t=>{
 const f=await fixture(t);await f.refresh();const old=f.store.get('discovery_source',f.source.id);delete old.lastRefreshSummary;f.store.put('discovery_source',old);assert.equal(f.discovery.snapshot().sources[0].lastRefreshSummary,undefined);
 f.set([posting(1,{title:'Updated engineering intern'}),posting(2)]);const next=await f.refresh();assert.equal(next.baseline,false);assert.equal(next.previousObservedAt,old.lastObservedAt);assert.deepEqual(next.counts,counts(0,0,1,1,0));
});

test('a timed-out read cannot overwrite the retained receipt or a later successful source observation',async t=>{
 const f=await fixture(t),first=await f.refresh();let release;const gate=new Promise(resolve=>{release=resolve;});f.discovery.timeoutMs=25;f.discovery.fetcher=async()=>{await gate;return new Response(JSON.stringify({jobs:[posting(9)],meta:{total:1}}));};
 await assert.rejects(f.refresh(),e=>e.code==='DISCOVERY_TIMEOUT');assert.deepEqual(f.store.get('discovery_source',f.source.id).lastRefreshSummary,first);
 f.discovery.fetcher=async()=>new Response(JSON.stringify({jobs:[posting(1),posting(3)],meta:{total:2}}));const later=await f.refresh();release();await new Promise(resolve=>setTimeout(resolve,10));assert.deepEqual(f.store.get('discovery_source',f.source.id).lastRefreshSummary,later);assert.equal(f.store.get('discovery_candidate',f.source.id+':9'),null);
});
