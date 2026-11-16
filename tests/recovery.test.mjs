import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,readFile,cp,rm,rename} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHub} from '../server/index.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const digest=b=>createHash('sha256').update(b).digest('hex');
test('full synthetic backup restoration preserves dirty bytes, original/final documents and uncertain dispatch history',async t=>{
 const base=await mkdtemp(path.join(tmpdir(),'hub-recovery-')),live=path.join(base,'live'),backup=path.join(base,'backup'),prior=path.join(base,'preserved-current');t.after(()=>rm(base,{recursive:true,force:true}));
 const script=path.join(base,'seed.mjs');await writeFile(script,`
 import {Store} from ${JSON.stringify(pathToFileURL(path.join(root,'server/store.mjs')).href)};
 import {ResumeService} from ${JSON.stringify(pathToFileURL(path.join(root,'server/resumes.mjs')).href)};
 import {mkdir,cp,writeFile} from 'node:fs/promises';import path from 'node:path';
 const live=${JSON.stringify(live)},backup=${JSON.stringify(backup)},store=new Store(live),resumes=new ResumeService({store,directory:live});
 await resumes.import([{name:'Recovery candidate.md',content:Buffer.from('# Recovery Candidate\\n\\n## Projects\\n### Sensor prototype\\n- Built a simulated Python sensor prototype with 12 controlled tests.').toString('base64')}]);
 const resume=store.list('resume')[0],job=store.put('job',{id:'restore-job',identity:'main|restore|1',url:'https://jobs.lever.co/restore/1',title:'Intern',employer:'Restore Lab',state:'applying',revision:0,activeAttemptId:'dispatch-1',posting:{open:true,sourceHash:'synthetic'}});const pkg=await resumes.select(job,resume.id);store.put('job',{...job,packageId:pkg.id});store.put('run',{id:'dispatch-1',jobId:job.id,identity:job.identity,state:'dispatched',dispatchedAt:new Date().toISOString(),packageId:pkg.id,packageHash:pkg.hash});store.put('campaign',{...store.get('campaign','main'),status:'running',enabled:true});
 await mkdir(backup,{recursive:true});await store.backup(path.join(backup,'hub.sqlite'));for(const name of ['resumes','packages'])await cp(path.join(live,name),path.join(backup,name),{recursive:true});await writeFile(path.join(backup,'expected.json'),JSON.stringify({resumeId:resume.id,packageId:pkg.id,resumePath:resume.originalPath,finalPath:pkg.finalPath,hash:pkg.hash}));
 store.put('profile',{...store.get('profile','main'),fullName:'Newer dirty profile bytes'});store.close();
 `);
 await new Promise((resolve,reject)=>{let error='';const child=spawn(process.execPath,[script],{stdio:['ignore','ignore','pipe'],env:process.env});child.stderr.on('data',b=>error+=b);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(error)));});
 const dirtyBefore=digest(await readFile(path.join(live,'hub.sqlite')));await rename(live,prior);await cp(backup,live,{recursive:true});assert.equal(digest(await readFile(path.join(prior,'hub.sqlite'))),dirtyBefore);
 const expected=JSON.parse(await readFile(path.join(backup,'expected.json'),'utf8'));let hub;try{hub=await createHub({directory:base,port:0});const ctx=hub.context(false),job=ctx.store.get('job','restore-job');assert.equal(ctx.store.get('campaign','main').status,'paused');assert.equal(job.state,'uncertain');assert.equal(ctx.store.get('run','dispatch-1').dispatchedAt.length>0,true);assert.equal(digest(await readFile(expected.finalPath)),expected.hash);assert((await readFile(expected.resumePath,'utf8')).includes('12 controlled tests'));assert.notEqual(ctx.store.get('profile','main').fullName,'Newer dirty profile bytes');assert.equal(digest(await readFile(path.join(prior,'hub.sqlite'))),dirtyBefore);await assert.rejects(ctx.engine.action('retry',{jobId:job.id}),/Reconcile/);}finally{await hub?.close();}
});
