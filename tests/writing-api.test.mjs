import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';
import {questionFingerprint} from '../server/writing-policy.mjs';
import {supportingControlFingerprint} from '../server/supporting-policy.mjs';
import {reasoningContext,reasoningQuestionHash} from '../server/reasoning-context.mjs';

async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-writing-api-'));
 const hub=await createHub({directory,port:0,modelRunner:async input=>{
  if(input.task==='draftWriting'){const source=input.sourceCatalog.find(item=>item.kind==='resume_fact'&&/simulated sensor prototype/.test(item.text));return {sentences:[{text:source.text.replace(/^[-*•]\s*/,''),sourceIds:[source.id]}],missingFacts:[],explanation:'Draft from supplied synthetic source; review required.'};}
  return {chosenResumeId:'synthetic-resume',edits:[],requirements:[],questions:[],structureEdits:[]};
 }});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const request=async(route,body)=>{const response=await fetch(hub.baseUrl+route,{headers:{Cookie:cookie,...(body?{Origin:hub.baseUrl,'Content-Type':'application/json'}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});return {response,value:await response.json().catch(()=>null)};};
 await request('/api/action',{action:'saveProfile',profile:{fullName:'Alex Example',email:'alex@example.invalid'}});
 const ctx=hub.context(false),profile=ctx.store.get('profile','main');ctx.store.put('connection',{id:'model',enabled:true,verified:true});
 await ctx.resumes.import([{name:'Synthetic finished.md',content:Buffer.from('# Alex Example\n\n## Projects\n### Sensor prototype\n- Built a simulated sensor prototype in Python with 12 controlled test cases.\n\n## Skills\nPython and signal processing').toString('base64')}]);
 let job=ctx.store.put('job',{id:'writing-job',identity:'synthetic-candidate|example|role-1',title:'Sensor engineering intern',employer:'Example Labs',url:'https://jobs.lever.co/example/role-1',state:'needs_you',revision:1,posting:{open:true,text:'Sensor engineering internship. Python is preferred. Assistance is permitted for written application answers.',sourceHash:'synthetic-posting'}});
 const pkg=await ctx.resumes.select(job,ctx.store.list('resume')[0].id);job=ctx.store.put('job',{...ctx.store.get('job',job.id),packageId:pkg.id});
 const expected=question=>({jobId:job.id,questionHash:question.kind==='document'?supportingControlFingerprint(question):questionFingerprint(question),packageId:pkg.id,postingHash:ctx.store.get('job',job.id).posting.sourceHash,profileRevision:ctx.store.get('profile','main').updatedAt});
 return {directory,hub,ctx,request,cookie,profile,job,pkg,expected};
}
const writingQuestion={label:'Describe a prototype you built',name:'prototype',kind:'writing',tag:'textarea',required:true,minLength:20,maxLength:2000,sourceUrl:'https://jobs.lever.co/example/role-1/apply'};
test('actual authenticated writing API retains a draft, redacts paths and requires exact review before answering',async t=>{
 const f=await fixture(t);f.ctx.store.put('decision',{id:'writing-decision',jobId:f.job.id,state:'open',code:'form_questions',details:{questions:[writingQuestion]}});
 const withoutPermission=await f.request('/api/action',{action:'draftWriting',decisionId:'writing-decision',questionLabel:writingQuestion.label,expectedBinding:f.expected(writingQuestion)});assert.equal(withoutPermission.response.status,409);assert.equal(f.ctx.store.get('usage','model'),null);
 const drafted=await f.request('/api/action',{action:'draftWriting',decisionId:'writing-decision',questionLabel:writingQuestion.label,allowedAssistance:true,expectedBinding:f.expected(writingQuestion)});assert.equal(drafted.response.status,200,JSON.stringify(drafted.value));assert.equal(drafted.value.state,'draft_needs_review');assert.match(drafted.value.text,/simulated sensor prototype/);assert(drafted.value.sourceEvidence.length);
 const state=(await f.request('/api/state')).value;assert.equal(state.writingDrafts.length,1);assert(!JSON.stringify(state).includes('originalPath'));
 assert.equal(f.ctx.store.get('decision','writing-decision').state,'open');assert.equal(f.ctx.store.get('job',f.job.id).state,'needs_you');
 const answer={[writingQuestion.label]:drafted.value.text};const notReviewed=await f.request('/api/action',{action:'resolveDecision',decisionId:'writing-decision',answer});assert.equal(notReviewed.response.status,400);
 const reviewed=await f.request('/api/action',{action:'resolveDecision',decisionId:'writing-decision',answer,writingReviews:{[writingQuestion.label]:true}});assert.equal(reviewed.response.status,200,JSON.stringify(reviewed.value));
 assert.equal(f.ctx.store.get('job',f.job.id).writingApprovals[writingQuestion.label].answerHash,drafted.value.answerHash);assert.equal(f.ctx.store.get('campaign','main').enabled,false);assert.equal(f.ctx.store.list('run').length,0);
});
test('actual supporting-file API serves verified bytes and includes them in a consistent private backup',async t=>{
 const f=await fixture(t),question={label:'Transcript',name:'transcript',kind:'document',type:'file',accept:'.txt',required:true,multiple:false,sourceUrl:'https://jobs.lever.co/example/role-1/apply'};
 f.ctx.store.put('decision',{id:'file-decision',jobId:f.job.id,state:'open',code:'form_questions',details:{questions:[question]}});
 const content=Buffer.from('Synthetic transcript for Alex Example. Example University. This is fixture data.');
 const attached=await f.request('/api/action',{action:'attachSupportingDocument',decisionId:'file-decision',questionLabel:question.label,expectedBinding:f.expected(question),file:{name:'Transcript.txt',content:content.toString('base64')},confirmed:true});assert.equal(attached.response.status,200,JSON.stringify(attached.value));assert.equal(attached.value.verified,true);assert(!attached.value.originalPath);assert(!attached.value.previewPath);
 const original=await fetch(f.hub.baseUrl+'/api/files/'+attached.value.id+'?variant=original',{headers:{Cookie:f.cookie}});assert.deepEqual(Buffer.from(await original.arrayBuffer()),content);
 const preview=await fetch(f.hub.baseUrl+'/api/files/'+attached.value.id,{headers:{Cookie:f.cookie}});assert.equal(preview.headers.get('content-type'),'application/pdf');assert.equal(Buffer.from(await preview.arrayBuffer()).subarray(0,5).toString(),'%PDF-');
 const state=(await f.request('/api/state')).value;assert.equal(state.supportingDocuments.length,1);assert.equal(state.jobs[0].state,'needs_you');
 const resolved=await f.request('/api/action',{action:'resolveDecision',decisionId:'file-decision',answer:{Transcript:{documentId:attached.value.id}}});assert.equal(resolved.response.status,200,JSON.stringify(resolved.value));
 const backedUp=await f.request('/api/action',{action:'backup'});assert.equal(backedUp.response.status,200,JSON.stringify(backedUp.value));const backup=path.join(f.directory,'backups',backedUp.value.name),manifest=JSON.parse(await readFile(path.join(backup,'manifest.json'),'utf8'));assert(manifest.files.includes('supporting-documents'));
 const saved=await readdir(path.join(backup,'supporting-documents',attached.value.id));assert(saved.some(name=>name.endsWith('.txt')));assert(saved.some(name=>name.endsWith('.pdf')));
 assert.equal(f.ctx.store.get('campaign','main').enabled,false);assert.equal(f.ctx.store.list('run').length,0);
});
test('manual finished-resume selection exposes each mandatory condition before marking the application ready',async t=>{
 const f=await fixture(t);f.ctx.store.put('job',{...f.ctx.store.get('job',f.job.id),posting:{...f.job.posting,text:f.job.posting.text+'\nMinimum GPA 3.5 required.',sourceHash:'gpa-posting'}});
 const selected=await f.request('/api/action',{action:'selectResume',jobId:f.job.id,resumeId:f.ctx.store.list('resume')[0].id});assert.equal(selected.response.status,200,JSON.stringify(selected.value));
 const saved=f.ctx.store.get('job',f.job.id);assert.equal(saved.state,'needs_you');assert(saved.requirementLedger.some(entry=>entry.quote==='Minimum GPA 3.5 required.'&&entry.status==='unanswered'));
 const decision=f.ctx.store.list('decision').find(entry=>entry.code==='eligibility_review'&&entry.state==='open');assert(decision);const legacy=await f.request('/api/action',{action:'resolveDecision',decisionId:decision.id,answer:'reviewed_eligible'});assert.equal(legacy.response.status,400);
 const answered=await f.request('/api/action',{action:'resolveDecision',decisionId:decision.id,answer:{[decision.details.requirements[0].id]:'eligible'}});assert.equal(answered.response.status,200,JSON.stringify(answered.value));assert.equal(f.ctx.store.get('job',f.job.id).state,'ready');assert.equal(f.ctx.store.list('run').length,0);
});
test('HTTP attachment review must name its exact displayed scope before any file is retained',async t=>{
 const f=await fixture(t),question={label:'Transcript',name:'transcript',kind:'document',type:'file',accept:'.txt',required:true,multiple:false,sourceUrl:'https://jobs.lever.co/example/role-1/apply'};
 f.ctx.store.put('decision',{id:'scope-file',jobId:f.job.id,state:'open',code:'form_questions',details:{questions:[question]}});
 const payload={action:'attachSupportingDocument',decisionId:'scope-file',questionLabel:question.label,file:{name:'Transcript.txt',content:Buffer.from('Synthetic reviewed candidate transcript.').toString('base64')},confirmed:true};
 assert.equal((await f.request('/api/action',payload)).response.status,400);
 for(const expectedBinding of [{...f.expected(question),questionHash:'previous-question'},{...f.expected(question),postingHash:'previous-posting'},{...f.expected(question),packageId:'previous-package'},{...f.expected(question),profileRevision:'previous-profile'},{...f.expected(question),unexpected:'ignored-authority'}]){
  const rejected=await f.request('/api/action',{...payload,expectedBinding});assert.equal(rejected.response.status,409);assert.equal(f.ctx.store.list('supportingDocument').length,0);
 }
 assert.equal(f.ctx.store.get('job',f.job.id).state,'needs_you');assert.equal(f.ctx.store.list('run').length,0);
});
test('answering an older reasoning question does not release manual control without reconciliation',async t=>{
 const f=await fixture(t),decision={id:'older-fact',jobId:f.job.id,type:'missing_fact',state:'open',question:'Which availability should be used?'};f.ctx.store.put('decision',{...decision,reasoningBinding:{...reasoningContext(f.ctx.store,f.ctx.store.get('job',f.job.id)),questionHash:reasoningQuestionHash(decision)}});
 assert.equal((await f.request('/api/action',{action:'takeover',jobId:f.job.id})).response.status,200);
 const answered=await f.request('/api/action',{action:'resolveDecision',decisionId:'older-fact',answer:'Candidate-supplied June availability'});assert.equal(answered.response.status,200);
 const manual=f.ctx.store.get('job',f.job.id);assert.equal(manual.state,'manual');assert.equal(manual.preparationRequested,false);assert.equal(manual.reasoningAnswers['Which availability should be used?'],'Candidate-supplied June availability');assert.equal(f.ctx.store.list('run').length,0);
 const released=await f.request('/api/action',{action:'release',jobId:f.job.id});assert.equal(released.response.status,200);assert.equal(f.ctx.store.get('job',f.job.id).state,'manual');
 const reconciled=await f.request('/api/action',{action:'resolveDecision',decisionId:released.value.id,answer:'not_submitted'});assert.equal(reconciled.response.status,200);assert.equal(f.ctx.store.get('job',f.job.id).state,'ready');assert.equal(f.ctx.store.list('run').length,0);
});
test('manual resume selection cannot bypass an employer cap found on another selected posting',async t=>{
 const f=await fixture(t),quote='Applicants may submit a maximum of two applications to Example Labs.';
 for(const [id,state,text] of [['prior-one','submitted',quote],['prior-two','uncertain','Another selected engineering internship.']]){
  const url='https://jobs.lever.co/example/'+id;f.ctx.store.put('job',{...f.job,id,identity:'main|lever:example|'+id,candidateId:'main',url,state,posting:{title:f.job.title,employer:f.job.employer,text,sourceHash:'posting-'+id,sourceUrl:url,observedAt:new Date().toISOString(),open:true,requirements:[]}});
 }
 const selected=await f.request('/api/action',{action:'selectResume',jobId:f.job.id,resumeId:f.ctx.store.list('resume')[0].id});assert.equal(selected.response.status,200,JSON.stringify(selected.value));const current=f.ctx.store.get('job',f.job.id);assert.equal(current.state,'needs_you');assert.equal(current.applicationLimitReport.effectiveCap,2);assert.equal(current.applicationLimitReport.reservationCount,2);
 const decision=f.ctx.store.list('decision').find(row=>row.jobId===f.job.id&&row.code==='application_limit_reached'&&row.state==='open');assert(decision);assert.equal(decision.details.report.confirmed[0].quote,quote);assert.equal(f.ctx.store.list('run').length,0);
});
test('an HTTP review cannot approve a prepared document after its retained fact is rejected',async t=>{
 const f=await fixture(t),fact=f.ctx.store.list('fact').find(row=>row.text.includes('simulated sensor prototype'));assert(fact);f.ctx.store.put('fact',{...fact,suppressed:true});
 const rejected=await f.request('/api/action',{action:'reviewPackage',packageId:f.pkg.id,approved:true});assert.equal(rejected.response.status,409);assert.equal(f.ctx.store.get('package',f.pkg.id).approved,false);assert.equal(f.ctx.store.list('run').length,0);
 f.ctx.store.put('fact',{...fact,suppressed:false});f.ctx.store.put('fact',{id:'unrelated-current-fact',text:'Unrelated source has 999 controlled cases.',conflict:true,sources:[{resumeId:'other-resume'}]});
 const approved=await f.request('/api/action',{action:'reviewPackage',packageId:f.pkg.id,approved:true});assert.equal(approved.response.status,200,JSON.stringify(approved.value));assert.equal(f.ctx.store.get('package',f.pkg.id).approved,true);assert.equal(f.ctx.store.get('campaign','main').enabled,false);
});
