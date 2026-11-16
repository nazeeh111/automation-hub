import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

// Actual import/render/action/worker/restart contract, with synthetic posting reads.
// No model calls, campaign enablement or employer dispatch is permitted.
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-selection-recovery-'));let version=1,reads=0,modelCalls=0,hub,ctx,cookie;
 const options={directory,port:0,modelRunner:async()=>{modelCalls++;throw Error('No model allowed');},engineAdapter:{inspect:async()=>{reads++;return {title:'Engineering intern',employer:'Synthetic Labs',text:'Python experience is preferred. Source '+version,sourceHash:'source-'+version,sourceUrl:'https://jobs.lever.co/synthetic/role',requirements:[],open:true};},readiness:async()=>({id:'browser',status:'ready',detail:'Synthetic read only'}),close:async()=>{}}};
 const open=async()=>{hub=await createHub(options);ctx=hub.context(false);clearInterval(ctx.engine.timer);ctx.engine.timer=null;const auth=await fetch(hub.launchUrl,{redirect:'manual'});cookie=auth.headers.get('set-cookie').split(';')[0];};await open();t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const action=async body=>{const response=await fetch(hub.baseUrl+'/api/action',{method:'POST',headers:{Cookie:cookie,Origin:hub.baseUrl,'X-Hub-Workspace':'real','Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 await action({action:'saveProfile',profile:{fullName:'Synthetic Candidate',email:'synthetic@example.test'}});
 const file=name=>({name:name+'.md',content:Buffer.from('# Synthetic Candidate\n\n## Projects\n### '+name+' prototype\n- Built a simulated '+name+' sensor in Python with controlled tests.\n\n## Skills\nPython').toString('base64')});const imported=await ctx.resumes.import([file('First'),file('Second')]);assert.deepEqual(imported.errors,[]);const [first,second]=ctx.store.list('resume');
 ctx.store.put('job',{id:'role',identity:'main|lever:us:synthetic|role|',url:'https://jobs.lever.co/synthetic/role',title:'Engineering intern',employer:'Synthetic Labs',state:'imported',revision:0});assert.equal((await action({action:'selectResume',jobId:'role',resumeId:first.id})).status,200);await ctx.engine.tick();
 return {action,first,second,get ctx(){return ctx;},setVersion:value=>version=value,restart:async()=>{await hub.close();await open();},counts:()=>({reads,modelCalls}),job:()=>ctx.store.get('job','role'),pkg:()=>ctx.store.get('package',ctx.store.get('job','role').packageId)};
}

test('latest successfully selected finished original survives restart and a changed posting preparation',async t=>{
 const f=await fixture(t);assert.equal(f.job().selectedResumeId,f.first.id);assert.equal(f.pkg().resumeId,f.first.id);const originalPackage=f.pkg();
 const result=await f.action({action:'selectResume',jobId:'role',resumeId:f.second.id});assert.equal(result.status,200);assert.equal(f.pkg().resumeId,f.second.id);assert.equal(f.job().selectedResumeId,f.second.id);assert.equal(f.pkg().postingBinding.sourceHash,'source-1');assert.notEqual(f.pkg().id,originalPackage.id);
 assert.equal((await f.action({action:'reviewPackage',packageId:f.pkg().id,approved:true})).status,200);await f.restart();assert.equal(f.job().selectedResumeId,f.second.id);
 f.setVersion(2);assert.equal((await f.action({action:'prepare',jobId:'role'})).status,200);await f.ctx.engine.tick();assert.equal(f.pkg().resumeId,f.second.id);assert.equal(f.job().selectedResumeId,f.second.id);assert.equal(f.pkg().postingBinding.sourceHash,'source-2');assert.equal(f.pkg().approved,false);assert.notEqual(f.pkg().postingBinding.observationId,originalPackage.postingBinding.observationId);
 assert.deepEqual(f.counts(),{reads:2,modelCalls:0});assert.equal(f.ctx.store.get('campaign','main').enabled,false);assert.equal(f.ctx.store.list('run').length,0);
});

test('changed replacement source cannot overwrite the last successful selection; restoring it permits exact recovery',async t=>{
 const f=await fixture(t),originalJob=f.job(),originalPackage=f.pkg(),bytes=await readFile(f.second.originalPath);await writeFile(f.second.originalPath,Buffer.from('Changed synthetic source bytes'),{mode:0o600});
 const failed=await f.action({action:'selectResume',jobId:'role',resumeId:f.second.id});assert.notEqual(failed.status,200);assert.equal(f.job().selectedResumeId,f.first.id);assert.equal(f.job().packageId,originalJob.packageId);assert.deepEqual(f.pkg(),originalPackage);assert.equal(f.job().state,originalJob.state);
 await writeFile(f.second.originalPath,bytes,{mode:0o600});const restored=await f.action({action:'selectResume',jobId:'role',resumeId:f.second.id});assert.equal(restored.status,200);assert.equal(f.job().selectedResumeId,f.second.id);assert.equal(f.pkg().resumeId,f.second.id);assert.equal(f.pkg().approved,false);assert.equal(f.pkg().postingBinding.sourceHash,'source-1');assert.equal(f.ctx.store.list('run').length,0);assert.equal(f.ctx.store.get('campaign','main').enabled,false);assert.equal(f.counts().modelCalls,0);
});
