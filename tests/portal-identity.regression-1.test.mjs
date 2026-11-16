import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {canonicalJob,importJobs} from '../server/index.mjs';
import {postingIdentity} from '../server/adapters.mjs';
import {Store} from '../server/store.mjs';

// Regression: BACKEND-001 — import identity must agree with the adapter requisition.
// Found by /qa on 2026-11-16.
// Report: docs/competitive-pass-2026-11-16/backend/REPORT.md
const routes=[
 ['greenhouse','https://job-boards.greenhouse.io/example/jobs/123',[
  'https://boards.greenhouse.io/example/jobs/123/apply',
  'https://job-boards.greenhouse.io/example/jobs/123/application?source=fixture'
 ]],
 ['greenhouse','https://job-boards.eu.greenhouse.io/example/jobs/123',[
  'https://job-boards.eu.greenhouse.io/example/jobs/123/apply'
 ]],
 ['lever','https://jobs.lever.co/example/req-123',[
  'https://jobs.lever.co/example/req-123/application',
  'https://jobs.lever.co/example/req-123/apply/review'
 ]],
 ['lever','https://jobs.eu.lever.co/example/req-123',[
  'https://jobs.eu.lever.co/example/req-123/application'
 ]]
];
for(const [portal,url,aliases] of routes)test(`import and adapter agree on ${url}`,()=>{
 for(const alias of aliases){
  assert.equal(postingIdentity(alias,portal),postingIdentity(url,portal));
  assert.equal(canonicalJob(alias).identity,canonicalJob(url).identity,alias);
 }
});

test('alias import cannot split retained dispatched history, including an older mismatched identity',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-import-identity-regression-'));
 let store=new Store(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const url=routes[0][1],alias=routes[0][2][0],identity='main|greenhouse:example|apply|';
 store.put('job',{id:'legacy-alias',identity,url:alias,state:'uncertain',title:'Engineering intern',employer:'Example',revision:1,evidence:[]});
 store.put('run',{id:'legacy-dispatch',jobId:'legacy-alias',identity,state:'uncertain',dispatchedAt:'2026-11-15T12:00:00Z'});
 const original=store.list('job'),attempts=store.list('run');
 assert.deepEqual(importJobs(store,[url,alias].join('\n')),{imported:0,duplicates:2,errors:[]});
 assert.deepEqual(store.list('job'),original);assert.deepEqual(store.list('run'),attempts);
 store.close();store=new Store(directory);
 assert.deepEqual(importJobs(store,url),{imported:0,duplicates:1,errors:[]});
 assert.deepEqual(store.list('job'),original);assert.deepEqual(store.list('run'),attempts);
});

// Regression: BACKEND-003 — Ashby manual queue selection must not duplicate its application URL.
test('Ashby job and manual application routes share one local identity without claiming a submission adapter',()=>{
 const base='https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001';
 assert.equal(canonicalJob(base).identity,canonicalJob(base+'/application?utm_source=fixture').identity);
 assert.equal(canonicalJob(base+'/application').portal,'unsupported');
 assert.notEqual(canonicalJob(base).identity,canonicalJob(base.replace('/example/','/other/')).identity);
});
test('retained Ashby application URL history prevents another local queue row after reopen',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-ashby-alias-'));let store=new Store(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 const base='https://jobs.ashbyhq.com/example/00000000-0000-4000-8000-000000000001';
 store.put('job',{id:'ashby-manual-history',url:base+'/application',identity:'old-ashby-route',state:'manual',revision:2,evidence:[]});const before=store.list('job');store.close();store=new Store(directory);
 assert.deepEqual(importJobs(store,base),{imported:0,duplicates:1,errors:[]});assert.deepEqual(store.list('job'),before);
});
