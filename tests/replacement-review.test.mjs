import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createHub} from '../server/index.mjs';

// Retained, rendered synthetic documents and the actual local action API.
// No browser, employer route, account access or campaign enablement is involved.
async function fixture(t,{otherQuestion=false,automaticReuse=false}={}){
 const directory=await mkdtemp('/tmp/hub-replacement-review-'),hub=await createHub({directory,port:0,open:false});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const ctx=hub.context(false),store=ctx.store;await ctx.engine.stop({releaseWorker:false});
 store.put('profile',{id:'main',fullName:'Alex Example',email:'alex@example.invalid',answers:{},links:{}});
 const imported=await ctx.resumes.import([{name:'Synthetic finished resume.md',content:Buffer.from('# Alex Example\n\n## Projects\n### Controlled simulation\n- Built a simulated sensor prototype in Python.\n- Measured 12 controlled simulation cases.\n\n## Skills\nPython and signal processing').toString('base64'),mega:false}]);assert.deepEqual(imported.errors,[]);
 const resume=store.list('resume')[0],job=store.put('job',{id:'job',identity:'main|lever:synthetic|job',title:'Engineering intern',employer:'Synthetic employer',url:'https://jobs.lever.co/synthetic/job',state:'needs_you',revision:0,posting:{open:true,title:'Engineering intern',employer:'Synthetic employer',sourceHash:'synthetic-posting',text:'Synthetic engineering internship.',requirements:[]}}),old=await ctx.resumes.select(job,resume.id);
 store.put('job',{...store.get('job','job'),packageId:old.id,state:'needs_you'});
 store.put('decision',{id:'old-review',jobId:'job',code:'package_review',state:'open',details:{packageId:old.id,hash:old.hash}});
 if(otherQuestion)store.put('decision',{id:'other-question',jobId:'job',code:'form_questions',state:'open',title:'Confirm the start date',message:'Confirm the start date',details:{questions:[{label:'Start date',kind:'answer',name:'start',type:'text',required:true,sourceUrl:job.url}]}});
 if(automaticReuse)store.put('campaign',{...store.get('campaign','main'),rules:{...store.get('campaign','main').rules,autoApproveUnchanged:true}});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const action=async body=>{const response=await fetch(hub.baseUrl+'/api/action',{method:'POST',headers:{Cookie:cookie,Origin:hub.baseUrl,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
 const saved=kind=>store.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY id').all(kind).map(row=>row.body);
 return {ctx,store,resume,old,action,saved};
}

test('successful resume recovery supersedes the obsolete review and approves the new exact version',async t=>{
 const f=await fixture(t),oldBytes=await readFile(f.old.finalPath);
 const selected=await f.action({action:'selectResume',jobId:'job',resumeId:f.resume.id});assert.equal(selected.status,200);assert.notEqual(selected.value.id,f.old.id);
 const current=f.store.get('package',selected.value.id),review=f.store.list('decision').find(d=>d.state==='open'&&d.code==='package_review');
 assert.equal(f.store.get('decision','old-review').state,'superseded');assert.equal(review.details.packageId,current.id);assert.equal(review.details.hash,current.hash);assert.equal(f.store.get('job','job').state,'needs_you');
 assert.equal(createHash('sha256').update(await readFile(current.finalPath)).digest('hex'),current.hash);
 const approval=await f.action({action:'resolveDecision',decisionId:review.id,answer:'approve'});assert.equal(approval.status,200);
 assert.equal(f.store.get('package',current.id).approved,true);assert.equal(f.store.get('package',f.old.id).approved,false);assert.equal(f.store.get('job','job').state,'ready');assert.equal(f.store.list('decision').filter(d=>d.state==='open').length,0);
 assert.deepEqual(await readFile(f.old.finalPath),oldBytes);assert.equal(f.store.get('campaign','main').enabled,false);assert.equal(f.store.list('run').length,0);
});

test('replacement document approval retains an independent employer question and its useful next action',async t=>{
 const f=await fixture(t,{otherQuestion:true}),question=f.store.get('decision','other-question');
 const selected=await f.action({action:'selectResume',jobId:'job',resumeId:f.resume.id});assert.equal(selected.status,200);
 const review=f.store.list('decision').find(d=>d.state==='open'&&d.code==='package_review');assert(review);
 const approval=await f.action({action:'resolveDecision',decisionId:review.id,answer:'approve'});assert.equal(approval.status,200);
 assert.deepEqual(f.store.get('decision','other-question'),question);assert.equal(f.store.get('job','job').state,'needs_you');assert.equal(f.store.get('job','job').nextAction,question.message);assert.equal(f.store.get('job','job').decisionId,question.id);
 assert.equal(f.store.get('package',selected.value.id).approved,true);assert.equal(f.store.get('campaign','main').enabled,false);assert.equal(f.store.list('run').length,0);
});

test('failed replacement preserves the original package and unresolved review bytes',async t=>{
 const f=await fixture(t),decisions=f.saved('decision'),packages=f.saved('package'),oldBytes=await readFile(f.old.finalPath);
 const failed=await f.action({action:'selectResume',jobId:'job',resumeId:'missing-source'});assert.notEqual(failed.status,200);
 assert.deepEqual(f.saved('decision'),decisions);assert.deepEqual(f.saved('package'),packages);assert.equal(f.store.get('job','job').packageId,f.old.id);assert.equal(f.store.get('job','job').state,'needs_you');assert.deepEqual(await readFile(f.old.finalPath),oldBytes);assert.equal(f.store.list('run').length,0);
});

test('unchanged reuse policy retires only the obsolete review without manufacturing another approval hold',async t=>{
 const f=await fixture(t,{automaticReuse:true}),selected=await f.action({action:'selectResume',jobId:'job',resumeId:f.resume.id});assert.equal(selected.status,200);
 assert.equal(f.store.get('decision','old-review').state,'superseded');assert.equal(f.store.get('package',selected.value.id).approved,true);assert.equal(f.store.get('job','job').state,'ready');assert.equal(f.store.list('decision').filter(d=>d.state==='open').length,0);
 assert.equal(f.store.get('campaign','main').enabled,false);assert.equal(f.store.list('run').length,0);
});
