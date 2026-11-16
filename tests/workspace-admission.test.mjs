import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-workspace-admission-')),hub=await createHub({directory,port:0,open:false});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const headers=workspace=>({Cookie:cookie,Origin:hub.baseUrl,'Content-Type':'application/json','X-Hub-Workspace':workspace});
 const post=async(route,body,workspace='real')=>{const response=await fetch(hub.baseUrl+route,{method:'POST',headers:headers(workspace),body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 return {hub,post,async beginSlow(route,value){
  const body=JSON.stringify(value);let seen;
  const received=new Promise(resolve=>seen=resolve);
  hub.server.once('request',request=>request.once('data',()=>seen()));
  let request;
  const response=new Promise((resolve,reject)=>{
   request=http.request(hub.baseUrl+route,{method:'POST',headers:{...headers('real'),'Content-Length':Buffer.byteLength(body)}},res=>{let raw='';res.on('data',part=>raw+=part);res.on('end',()=>{try{resolve({status:res.statusCode,body:JSON.parse(raw)});}catch(error){reject(error);}});});
   request.setTimeout(5000,()=>request.destroy(new Error('Synthetic streamed request timed out')));request.on('error',reject);request.write(body.slice(0,1));
  });
  await received;return {finish:()=>{request.end(body.slice(1));return response;}};
 }};
}

const routes=[
 ['/api/action',{action:'registerWorkflow',name:'Delayed real intent',url:'https://flows.example.invalid/workflow/streamedIntent'}],
 ['/api/import/jobs',{text:'https://jobs.lever.co/owned-fixture/streamed-role'}],
 ['/api/import/resumes',{files:[{name:'streamed.md',content:Buffer.from('# Synthetic Candidate\nEngineering student\n').toString('base64')}]}],
 ['/api/demo',{enabled:false}],
];

for(const aba of [false,true])for(const [route,body] of routes)test(`streamed ${route} rejects a workspace ${aba?'switch away and back':'switch'} before body admission`,async t=>{
 const {hub,post,beginSlow}=await fixture(t),slow=await beginSlow(route,body);
 assert.equal((await post('/api/demo',{enabled:true})).status,200);
 if(aba)assert.equal((await post('/api/demo',{enabled:false},'fixture')).status,200);
 const before={real:hub.context(false).store.list('automation').length,fixture:hub.context(true).store.list('automation').length};
 const result=await slow.finish();assert.equal(result.status,409);assert.equal(result.body.code,'WORKSPACE_CHANGED');
 assert.equal(hub.context(false).store.list('job').length,0);assert.equal(hub.context(false).store.list('resume').length,0);
 assert.equal(hub.context(false).store.list('automation').length,before.real);assert.equal(hub.context(true).store.list('automation').length,before.fixture);
});

test('nonboolean workspace toggles never seed synthetic profile or files into real data',async t=>{
 const {hub,post}=await fixture(t);
 for(const enabled of ['true','false',1,0,{},[],null,undefined])assert.equal((await post('/api/demo',{enabled})).status,400);
 const store=hub.context(false).store;
 assert.equal(store.list('job').length,0);assert.equal(store.list('resume').length,0);assert.ok(!store.get('profile','main').fullName);
 assert.equal((await post('/api/demo',{enabled:false})).status,200);
});

test('switch response rejects if another tab changes mode while its committed snapshot is being built',async t=>{
 const {hub,post}=await fixture(t),connection=hub.context(true).connections,original=connection.snapshot.bind(connection);
 let entered,release,firstSnapshot=true;
 const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 connection.snapshot=async()=>{if(firstSnapshot){firstSnapshot=false;entered();await gate;}return original();};
 const pending=post('/api/demo',{enabled:true});await started;
 try{assert.equal((await post('/api/demo',{enabled:false},'fixture')).status,200);}finally{release();}
 const delayed=await pending;assert.equal(delayed.status,409);assert.equal(delayed.body.code,'WORKSPACE_CHANGED');
 // Fresh real binding remains usable after the rejected stale acknowledgement.
 assert.equal((await post('/api/action',{action:'registerWorkflow',name:'Current real workspace',url:'https://flows.example.invalid/workflow/currentAfterRace'})).status,200);
 assert.equal(hub.context(false).store.list('automation').filter(a=>a.workflowId==='currentAfterRace').length,1);
 assert.equal(hub.context(true).store.list('automation').filter(a=>a.workflowId==='currentAfterRace').length,0);
});
