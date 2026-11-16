import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDiscoveryView,updateDiscoveryView,clampDiscoveryOffset} from '../web/discovery-session.mjs';

// Value: protects=intent-only restoration and page resets; fails_when=data snapshots enter the cache or initial offsets vanish; why_new=Discover had no serializable view boundary; seam=none; no_claim=browser/API/provider acceptance.
test('restoration preserves the saved page and selection while dropping candidate/result authority',()=>{
 const saved={query:'controls',scope:'saved',company:'lever:us:example',location:'Boston',field:'Engineering',style:'hybrid',sort:'company',offset:80,selectedId:'role-84',includeUnavailable:false,filtersOpen:true,sourcesOpen:true,candidates:[{title:'Old result'}],result:{total:99},cookie:'never retain'};
 const view=normalizeDiscoveryView(saved);assert.equal(view.offset,80);assert.equal(view.selectedId,'role-84');assert.equal(view.query,'controls');assert.equal(view.includeUnavailable,false);assert.equal(view.filtersOpen,true);assert.equal(view.sourcesOpen,true);assert(!Object.hasOwn(view,'candidates'));assert(!Object.hasOwn(view,'result'));assert(!Object.hasOwn(view,'cookie'));assert.deepEqual(JSON.parse(JSON.stringify(view)),view);assert.equal(saved.offset,80);
});
test('changing filters resets the saved page and selection atomically; unchanged fields and disclosure state do not',()=>{
 const view=normalizeDiscoveryView({query:'controls',offset:80,selectedId:'role-84'});
 for(const [field,value]of Object.entries({query:'sensors',scope:'all',company:'other',location:'Boston',field:'Physics',style:'hybrid',sort:'company',includeUnavailable:false})){const next=updateDiscoveryView(view,field,value);assert.equal(next.offset,0,field);assert.equal(next.selectedId,null,field);assert.equal(view.offset,80);}
 assert.equal(updateDiscoveryView(view,'query','controls'),view);const disclosed=updateDiscoveryView(view,'filtersOpen',value=>!value);assert.equal(disclosed.offset,80);assert.equal(disclosed.selectedId,'role-84');assert.equal(disclosed.filtersOpen,true);assert.equal(updateDiscoveryView(view,'result',{}),view);
});
test('invalid view fields cannot become query state and offsets are bounded page starts',()=>{
 const view=normalizeDiscoveryView({query:{},scope:'admin',sort:'unknown',offset:'80',selectedId:{id:'old'},includeUnavailable:'false'});assert.equal(view.query,'');assert.equal(view.scope,'us');assert.equal(view.sort,'firstSeen');assert.equal(view.offset,0);assert.equal(view.selectedId,null);assert.equal(view.includeUnavailable,true);
 assert.equal(normalizeDiscoveryView({offset:81}).offset,80);assert.equal(normalizeDiscoveryView({offset:150001}).offset,0);assert.equal(normalizeDiscoveryView({offset:-40}).offset,0);
});
test('shrinking pages clamp to a current page without interpreting missing roles as closed',()=>{
 assert.equal(clampDiscoveryOffset(80,85),80);assert.equal(clampDiscoveryOffset(80,63),40);assert.equal(clampDiscoveryOffset(40,40),0);assert.equal(clampDiscoveryOffset(80,0),0);assert.equal(clampDiscoveryOffset(0,85),0);for(const total of [-1,undefined,2.5])assert.throws(()=>clampDiscoveryOffset(80,total),/could not be verified/);
});
