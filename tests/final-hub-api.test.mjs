import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';
async function fixture(t){const directory=await mkdtemp(path.join(tmpdir(),'hub-final-api-'));const hub=await createHub({directory,port:0});t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];return {hub,request:async(route,body,workspace)=>{const r=await fetch(hub.baseUrl+route,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{'Content-Type':'application/json',Origin:hub.baseUrl}),...(workspace===undefined?{}:{'X-Hub-Workspace':workspace})},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}};}
test('workflow trailing slash aliases reuse a legacy observation record without rewriting history',async t=>{
 const {hub,request}=await fixture(t),store=hub.context(false).store;
 store.put('automation',{id:'legacy-observed',name:'My existing workflow',executor:'n8n',externalUrl:'https://flows.example.invalid/personal/workflow/OwnerCase/',workflowId:'OwnerCase',observation:{observedAt:'2026-11-14T12:00:00Z',workflow:{id:'OwnerCase',active:true}}});const before=store.get('automation','legacy-observed');
 const result=await request('/api/action',{action:'registerWorkflow',name:'Linked again',url:'https://FLOWS.example.invalid:443/personal/workflow/OwnerCase'});assert.equal(result.status,200);assert.equal(result.data.id,before.id);assert.deepEqual(store.get('automation','legacy-observed'),before);assert.equal(store.list('automation').filter(a=>a.executor==='n8n').length,1);
});
test('new workflow registration canonicalizes aliases but preserves instance, basepath and case identity',async t=>{
 const {hub,request}=await fixture(t);const urls=['https://flows.example.invalid/workflow/OwnerCase/','https://flows.example.invalid/workflow/OwnerCase','https://other.example.invalid/workflow/OwnerCase','https://flows.example.invalid/personal/workflow/OwnerCase','https://flows.example.invalid/workflow/ownercase'];let first;
 for(const url of urls){const r=await request('/api/action',{action:'registerWorkflow',name:'A workflow',url});assert.equal(r.status,200);if(!first)first=r.data;else if(url===urls[1])assert.equal(r.data.id,first.id);}
 assert.equal(first.externalUrl,urls[1]);assert.equal(hub.context(false).store.list('automation').filter(a=>a.executor==='n8n').length,4);
});
test('unsupported workflow IDs and malformed or oversized metadata reject before registry write',async t=>{
 const {hub,request}=await fixture(t);for(const body of [{name:'x',url:'bad URL'},{name:'x'.repeat(121),url:'https://flows.example.invalid/workflow/a'},{name:[],url:'https://flows.example.invalid/workflow/a'},{name:'x',url:'https://flows.example.invalid/workflow/'+ 'a'.repeat(129)}])assert.equal((await request('/api/action',{action:'registerWorkflow',...body})).status,400);assert.equal(hub.context(false).store.list('automation').length,1);
});
test('stale cross-window workspace bindings cannot write or toggle another workspace',async t=>{
 const {hub,request}=await fixture(t);assert.equal((await request('/api/demo',{enabled:true},'real')).status,200);
 for(const [route,body] of [['/api/import/jobs',{text:'https://jobs.lever.co/fixture/role'}],['/api/import/resumes',{files:[]}],['/api/action',{action:'pause'}],['/api/demo',{enabled:false}]]){const r=await request(route,body,'real');assert.equal(r.status,409);assert.equal(r.data.code,'WORKSPACE_CHANGED');}
 assert.equal((await request('/api/state')).data.demo,true);assert.equal(hub.context(false).store.list('job').length,0);assert.equal((await request('/api/demo',{enabled:false},'fixture')).status,200);assert.equal((await request('/api/action',{action:'pause'},'invalid')).status,400);
});
