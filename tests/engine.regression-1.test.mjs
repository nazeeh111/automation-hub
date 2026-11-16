import {bindPreparedPosting} from './fixtures/posting.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';

// Regression: ISSUE-002 — old alias identities cannot repeat a reserved posting
// Found by /qa on 2026-11-16
// Report: docs/competitive-pass-2026-11-16/backend/REPORT.md
async function fixture(t,{duringFill=false,otherRegion=false,reservation='uncertain'}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-retained-alias-regression-')),store=new Store(directory);
 store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:'synthetic@example.test',answers:{}});
 store.put('resume',{id:'source',mega:false});
 const url='https://jobs.lever.co/example/req-123';
 const posting={title:'Engineering intern',employer:'Example Labs',text:'Engineering internship. Python preferred.',requirements:[],sourceHash:'posting',open:true,sourceUrl:url};
 store.put('job',{id:'current',identity:'main|lever:us:example|req-123|',url,state:'ready',revision:0,title:posting.title,employer:posting.employer,posting,packageId:'package'});
 store.put('package',bindPreparedPosting(store,store.get('job','current'),{id:'package',jobId:'current',verified:true,approved:true,requirements:[],hash:'synthetic',finalPath:'/not-opened.pdf'}));
 const previous=()=>{
  store.put('job',{id:'older',identity:'main|lever:example|req-123/application|',url:`https://${otherRegion?'jobs.eu.lever.co':'jobs.lever.co'}/example/req-123/application`,state:reservation==='dispatch'?'failed':reservation,revision:1,title:posting.title,employer:posting.employer});
  if(reservation==='dispatch')store.put('run',{id:'older-dispatch',jobId:'older',identity:'main|lever:example|req-123/application|',state:'uncertain',dispatchedAt:'2026-11-15T12:00:00Z'});
 };
 let fills=0,dispatches=0;
 const engine=new Engine({store,directory,resumes:{},adapter:{inspect:async job=>job.posting,submit:async(job,profile,pkg,{beforeDispatch})=>{fills++;if(duringFill)previous();beforeDispatch();dispatches++;return {status:'uncertain'};},close:async()=>{}}});
 if(!duringFill)previous();
 await engine.action('savePolicy',{rules:{allowedHosts:['jobs.lever.co'],maxApplications:10,maxPerEmployer:3}});
 const campaign=await engine.action('enableCampaign',{confirmed:true});
 t.after(async()=>{await engine.stop();store.close();await rm(directory,{recursive:true,force:true});});
 return {store,engine,campaign,counts:()=>({fills,dispatches})};
}

for(const reservation of ['uncertain','manual','submitted','interview','dispatch'])test(`retained ${reservation} alias blocks repeat submission before form filling`,async t=>{
 const f=await fixture(t,{reservation});const previous=f.store.get('job','older'),runs=f.store.list('run');
 await f.engine.apply(f.store.get('job','current'),f.campaign);
 assert.deepEqual(f.counts(),{fills:0,dispatches:0});
 assert.equal(f.store.get('job','current').state,'needs_you');
 assert.equal(f.store.list('decision').find(d=>d.state==='open').code,'prior_application_uncertain');
 assert.deepEqual(f.store.get('job','older'),previous);assert.deepEqual(f.store.list('run'),runs);
});

test('a same-posting manual record arriving during fill fences immediate dispatch',async t=>{
 const f=await fixture(t,{duringFill:true,reservation:'manual'});
 await f.engine.apply(f.store.get('job','current'),f.campaign);
 assert.deepEqual(f.counts(),{fills:1,dispatches:0});
 assert.equal(f.store.get('job','current').state,'needs_you');
 assert.equal(f.store.list('run').find(run=>run.jobId==='current').dispatchedAt,undefined);
});

test('a different Lever region with the same requisition does not block the current role',async t=>{
 const f=await fixture(t,{otherRegion:true});
 await f.engine.apply(f.store.get('job','current'),f.campaign);
 assert.deepEqual(f.counts(),{fills:1,dispatches:1});
});
