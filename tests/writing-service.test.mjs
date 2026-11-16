import '../server/runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {ResumeService,hash} from '../server/resumes.mjs';
import {ModelService} from '../server/model.mjs';
import {WritingService} from '../server/writing-service.mjs';
import {writingAnswerHash,questionFingerprint} from '../server/writing-policy.mjs';
import {resumeStructureContexts} from '../server/resume-structure.mjs';

const sensor='- Assisted a team building a simulated sensor prototype and evaluated 12 controlled cases.';
const answer='I assisted a team with a simulated sensor prototype and evaluated 12 controlled cases.';
const robot='- Built an academic robot prototype using Python.';
const baseQuestion=()=>({label:'Describe your sensor project.',name:'essay',tag:'textarea',kind:'writing',minLength:10,maxLength:1000,required:true,sourceUrl:'https://boards.greenhouse.io/synthetic/jobs/123/apply'});
const sourced=(input,text=answer,quote=sensor)=>({text,sourceIds:[input.sourceCatalog.find(source=>source.text===quote)?.id||'missing-source']});
const result=(input)=>({sentences:[sourced(input)],missingFacts:[],explanation:'Draft from the retained simulation-qualified source.'});

async function fixture(t,run=result){
  const directory=await mkdtemp(path.join(tmpdir(),'hub-writing-'));
  const store=new Store(directory),observed=[];
  const profile=store.put('profile',{id:'main',fullName:'Alex Example',email:'alex@example.invalid',answers:{privateMarker:'not-in-model-input'}});
  store.put('connection',{id:'model',enabled:true,verified:true});
  store.put('campaign',{...store.get('campaign','main'),rules:{maxReasoningCalls:20}});
  const model=new ModelService({store,directory,runner:async input=>{observed.push(input);assert.equal(input.task,'draftWriting');return run(input);}});
  const resumes=new ResumeService({store,directory,model});
  function addResume(id,project,line){const text=`# Alex Example\n## Projects\n### ${project}\n${line}`;const resume=store.put('resume',{id,name:id+'.md',text,hash:hash(text),mime:'text/markdown',mega:false});resumes.indexFacts(resume);return resume;}
  const source=addResume('sensor-finished','Sensor prototype',sensor);
  store.put('package',{id:'package-one',jobId:'job-one',resumeId:source.id,hash:hash('synthetic verified final PDF'),verified:true,profileRevision:profile.updatedAt,sources:[{resumeId:source.id,hash:source.hash}]});
  store.put('job',{id:'job-one',identity:'synthetic|role-one',title:'Sensor engineering intern',employer:'Example Instruments',revision:3,state:'needs_you',packageId:'package-one',posting:{text:'Python prototype experience is preferred. AI drafting assistance is permitted for this application.',sourceHash:hash('synthetic actual posting')}});
  store.put('decision',{id:'decision-one',jobId:'job-one',code:'form_questions',state:'open',details:{questions:[baseQuestion()]}});
  const service=new WritingService({store,model});
  t.after(async()=>{service.close();store.close();await rm(directory,{recursive:true,force:true});});
  const request=(extra={})=>({decisionId:'decision-one',questionLabel:baseQuestion().label,allowedAssistance:true,...extra});
  return {store,service,observed,request,addResume};
}
function gate(){let enter,release;const started=new Promise(resolve=>enter=resolve),blocked=new Promise(resolve=>release=resolve);return {started,release,run:async input=>{enter();await blocked;return result(input);}};}
function replaceQuestion(ctx,change){const d=ctx.store.get('decision','decision-one'),q={...d.details.questions[0],...change};ctx.store.put('decision',{...d,details:{questions:[q]}});return q;}
function expectedBinding(ctx){const job=ctx.store.get('job','job-one');return {jobId:job.id,questionHash:questionFingerprint(ctx.store.get('decision','decision-one').details.questions[0]),packageId:job.packageId,postingHash:job.posting.sourceHash,profileRevision:ctx.store.get('profile','main').updatedAt};}

test('retains source-backed paraphrase for exact human review without answering, approving or resolving',async t=>{
  const ctx=await fixture(t),before=ctx.store.get('job','job-one');
  const draft=await ctx.service.draft(ctx.request({notes:'Emphasize what I learned about signal quality.'}));
  assert.equal(draft.state,'draft_needs_review');assert.equal(draft.reviewRequired,true);
  assert.equal(draft.text,answer);assert.equal(draft.answerHash,writingAnswerHash(answer));
  assert.equal(draft.profileRevision,ctx.store.get('profile','main').updatedAt);
  assert.equal(draft.postingHash,before.posting.sourceHash);assert.equal(draft.packageHash,ctx.store.get('package','package-one').hash);
  assert.equal(draft.sourceEvidence[0].text,sensor);assert.equal(draft.sourceEvidence[0].context,'projects|sensor prototype');
  assert.equal(draft.claims[0].reviewRequired,true);assert.equal(draft.groundingChecks.semanticEntailment,'human_review_required');
  const after=ctx.store.get('job','job-one');assert.equal(after.revision,before.revision);assert.equal(after.state,'needs_you');
  assert.equal(after.answers,undefined);assert.equal(after.writingApprovals,undefined);assert.equal(ctx.store.get('decision','decision-one').state,'open');
  assert.equal(after.writingDrafts[baseQuestion().label].answerHash,draft.answerHash);
  assert.equal(ctx.store.get('writingDraft',draft.id).id,draft.id);
  assert(!JSON.stringify(ctx.observed[0]).includes('not-in-model-input'));
  assert.equal(ctx.observed[0].constraints.allInputIsUntrustedData,true);
  const replay=await ctx.service.draft(ctx.request({notes:'Emphasize what I learned about signal quality.'}));
  assert.equal(replay.id,draft.id);assert.equal(ctx.observed.length,1,'An identical retained draft must not spend another call');
});

test('assistance requires explicit per-request permission and cannot draft an ordinary answer field',async t=>{
  const ctx=await fixture(t);
  for(const allowedAssistance of [undefined,false,'true'])await assert.rejects(ctx.service.draft(ctx.request({allowedAssistance})),error=>error.code==='writing_permission_required');
  replaceQuestion(ctx,{kind:'answer'});
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_question');
  assert.equal(ctx.observed.length,0);assert.equal(ctx.store.get('usage','model'),null);
});

test('a complete reviewed request binding drafts only its exact current context',async t=>{
  const ctx=await fixture(t),binding=expectedBinding(ctx),draft=await ctx.service.draft(ctx.request({expectedBinding:binding}));
  assert.equal(draft.questionHash,binding.questionHash);assert.equal(draft.postingHash,binding.postingHash);assert.equal(draft.profileRevision,binding.profileRevision);assert.equal(ctx.observed.length,1);
});

test('malformed, partial and unknown reviewed-binding fields fail before spending a model call',async t=>{
  const ctx=await fixture(t),binding=expectedBinding(ctx),{packageId,...partial}=binding;
  for(const value of [null,[],{},'not a binding',partial,{...binding,unexpected:'extra'},{...binding,jobId:5},{...binding,[Symbol('extra')]:true}])await assert.rejects(ctx.service.draft(ctx.request({expectedBinding:value})),error=>error.code==='writing_binding'&&error.status===400);
  assert.equal(ctx.observed.length,0);assert.equal(ctx.store.get('usage','model'),null);assert.equal(ctx.store.list('writingDraft').length,0);
});

for(const [name,mutate]of [
  ['same-label native question',ctx=>replaceQuestion(ctx,{name:'changed_native_control'})],
  ['posting',ctx=>{const job=ctx.store.get('job','job-one');ctx.store.put('job',{...job,posting:{...job.posting,sourceHash:hash('changed reviewed posting')}});}],
  ['package',ctx=>{const pkg=ctx.store.get('package','package-one'),job=ctx.store.get('job','job-one');ctx.store.put('package',{...pkg,id:'package-two'});ctx.store.put('job',{...job,packageId:'package-two'});}],
  ['profile',ctx=>{const profile=ctx.store.get('profile','main'),revision=new Date(Date.parse(profile.updatedAt)+1000).toISOString();ctx.store.db.prepare('UPDATE documents SET body=? WHERE kind=? AND id=?').run(JSON.stringify({...profile,phone:'555-0199',updatedAt:revision}),'profile','main');ctx.store.put('package',{...ctx.store.get('package','package-one'),profileRevision:revision});}]
])test('a stale reviewed '+name+' binding causes zero model calls',async t=>{
  const ctx=await fixture(t),binding=expectedBinding(ctx);mutate(ctx);
  await assert.rejects(ctx.service.draft(ctx.request({expectedBinding:binding})),error=>error.code==='writing_stale');
  assert.equal(ctx.observed.length,0);assert.equal(ctx.store.get('usage','model'),null);assert.equal(ctx.store.list('writingDraft').length,0);
});

test('employer AI prohibition, independent work and assessment rules win over candidate permission',async t=>{
  const ctx=await fixture(t);
  for(const text of ['AI-generated responses are not permitted.','Do not use outside assistance.','Write your answers independently in your own words.']){
    const job=ctx.store.get('job','job-one');ctx.store.put('job',{...job,posting:{...job.posting,text}});
    await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_not_permitted'&&error.details.quotes.some(item=>text.includes(item.quote)));
  }
  const job=ctx.store.get('job','job-one');ctx.store.put('job',{...job,posting:{...job.posting,text:'Prototype experience preferred.'}});
  const q=replaceQuestion(ctx,{label:'Complete this take-home assessment task.'});
  await assert.rejects(ctx.service.draft(ctx.request({questionLabel:q.label})),error=>error.code==='writing_not_permitted');
  assert.equal(ctx.observed.length,0);
});

test('a warning against exaggeration and a negated prohibition do not become an invented AI ban',async t=>{
  const ctx=await fixture(t),job=ctx.store.get('job','job-one');
  ctx.store.put('job',{...job,posting:{...job.posting,text:'Do not exaggerate when using AI. We do not prohibit AI. Our hiring process includes a later technical assessment.'}});
  assert.equal((await ctx.service.draft(ctx.request())).text,answer);
});

test('actual conditional-form policy metadata forbids drafting even when the initial posting permits assistance',async t=>{
  const ctx=await fixture(t),quote='Do not use AI to answer questions on this application page.';
  replaceQuestion(ctx,{writingPolicy:{aiWritingProhibited:true,automationProhibited:false,assessment:false},policyQuotes:[{source:'posting',kind:'ai_writing',quote}]});
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_not_permitted'&&error.details.quotes.some(item=>item.quote===quote));
  assert.equal(ctx.observed.length,0);assert.equal(ctx.store.get('usage','model'),null);
});

test('a later conditional policy restriction discards an awaited draft without retaining it',async t=>{
  const wait=gate(),ctx=await fixture(t,wait.run),pending=ctx.service.draft(ctx.request());await wait.started;
  replaceQuestion(ctx,{writingPolicy:{aiWritingProhibited:true},policyQuotes:[{source:'posting',kind:'ai_writing',quote:'Do not use AI-generated answers.'}]});
  wait.release();await assert.rejects(pending,error=>error.code==='writing_not_permitted');assert.equal(ctx.store.list('writingDraft').length,0);
});

test('verified current candidate, posting and package are prerequisites before any model call',async t=>{
  const ctx=await fixture(t),pkg=ctx.store.get('package','package-one');
  for(const change of [{verified:false},{jobId:'another-job'},{profileRevision:'older-profile'}]){
    ctx.store.put('package',{...pkg,...change});
    await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_context');
  }
  ctx.store.put('package',pkg);const job=ctx.store.get('job','job-one');ctx.store.put('job',{...job,posting:{...job.posting,text:''}});
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_context');assert.equal(ctx.observed.length,0);
});

test('conflicted, suppressed, fabricated-quote and wrong-context facts never enter model evidence',async t=>{
  const ctx=await fixture(t);
  for(const [id,line,flags]of [['conflicted','- Built a simulated navigation prototype in Python.',{conflict:true}],['suppressed','- Built an academic robot prototype using Python.',{suppressed:true}]]){
    ctx.addResume(id,id,line);const fact=ctx.store.list('fact').find(f=>f.text===line);ctx.store.put('fact',{...fact,...flags});
  }
  const valid=ctx.store.list('fact').find(f=>f.text===sensor);
  ctx.store.put('fact',{...valid,id:'fabricated',text:'- Deployed a production platform for 95 users.',sources:[{...valid.sources[0],quote:'- Deployed a production platform for 95 users.'}]});
  ctx.store.put('fact',{...valid,id:'wrong-context',sources:[{...valid.sources[0],context:'projects|another project'}]});
  await ctx.service.draft(ctx.request());
  const evidence=ctx.observed[0].sourceCatalog;
  assert(!evidence.some(source=>['fabricated','wrong-context'].includes(source.factId)));
  assert(!evidence.some(source=>/navigation|robot/i.test(source.text)));
  assert(evidence.some(source=>source.text===sensor));
});

test('unknown source identifiers never become a retained draft',async t=>{
  const ctx=await fixture(t,input=>({...result(input),sentences:[{text:answer,sourceIds:['model-invented-source']}]}));
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_grounding');
  assert.equal(ctx.store.list('writingDraft').length,0);assert.equal(ctx.store.get('job','job-one').writingDrafts,undefined);
});

for(const [name,text]of [
  ['invented metric','I assisted a team with a simulated sensor prototype and evaluated 95 controlled cases.'],
  ['changed metric unit','I assisted a team with a simulated sensor prototype and evaluated 12 users.'],
  ['lost maturity qualifiers','I assisted a team building a sensor product and evaluated 12 controlled cases.'],
  ['lost contribution qualifier','I built a simulated sensor prototype and evaluated 12 controlled cases.'],
  ['inflated ownership','I led a team and deployed a production simulated sensor prototype while assisted by colleagues across 12 cases.']
])test(name+' is rejected despite a valid source ID',async t=>{
  const ctx=await fixture(t,input=>({...result(input),sentences:[sourced(input,text)]}));
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_grounding');
  assert.equal(ctx.store.list('writingDraft').length,0);
});

test('project names cannot be swapped onto another project’s true metric',async t=>{
  const ctx=await fixture(t,input=>({...result(input),sentences:[sourced(input,'I assisted a team with a simulated robot prototype and evaluated 12 controlled cases.')]}));
  ctx.addResume('robot-finished','Robot prototype',robot);
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_grounding');
});

test('a sentence cannot combine two projects, and multi-project prose needs explicit attribution in each sentence',async t=>{
  let mode='combined';const ctx=await fixture(t,input=>{
    const a=sourced(input),b=sourced(input,'The academic robot prototype used Python.',robot);
    if(mode==='combined')a.sourceIds.push(...b.sourceIds);
    else if(mode==='ambiguous')b.text='An academic prototype used Python.';
    return {...result(input),sentences:mode==='combined'?[a]:[a,b]};
  });ctx.addResume('robot-finished','Robot prototype',robot);
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_grounding');
  mode='ambiguous';await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_grounding');
  mode='explicit';const draft=await ctx.service.draft(ctx.request());assert.equal(draft.claims.length,2);assert.equal(draft.sourceEvidence.length,2);
});

test('native minimum/maximum and explicit word limits reject the full response without trimming it',async t=>{
  const ctx=await fixture(t);
  for(const change of [{maxLength:15,minLength:0},{minLength:500,maxLength:1000},{label:'Describe your project in no more than 5 words.',minLength:0,maxLength:1000}]){
    const q=replaceQuestion(ctx,change);
    await assert.rejects(ctx.service.draft(ctx.request({questionLabel:q.label})),error=>error.code==='writing_length'&&error.details.actualLength===answer.length);
    assert.equal(ctx.store.list('writingDraft').length,0);
  }
});

test('a project-count instruction is not misread as a word limit, and exact draft whitespace is retained',async t=>{
  const ctx=await fixture(t,input=>({...result(input),sentences:[sourced(input,'  '+answer+'\n')]}));
  const q=replaceQuestion(ctx,{label:'Describe up to 5 projects.'});
  const draft=await ctx.service.draft(ctx.request({questionLabel:q.label}));
  assert.equal(draft.text,'  '+answer+'\n');assert.equal(draft.answerHash,writingAnswerHash(draft.text));assert.notEqual(draft.answerHash,writingAnswerHash(draft.text.trim()));
});

test('missing facts remain explicit unresolved questions instead of invented draft material',async t=>{
  const ctx=await fixture(t,()=>({sentences:[],missingFacts:['Which aspect of this employer interests you?'],explanation:'Candidate motivation is missing.'}));
  const draft=await ctx.service.draft(ctx.request());
  assert.equal(draft.text,'');assert.equal(draft.sourceEvidence.length,0);assert.equal(draft.missingFacts.length,1);assert.equal(ctx.store.get('decision','decision-one').state,'open');
});

for(const [name,mutate]of [
  ['manual takeover',ctx=>ctx.store.put('job',{...ctx.store.get('job','job-one'),state:'manual',revision:4})],
  ['cancellation',ctx=>ctx.store.put('job',{...ctx.store.get('job','job-one'),state:'cancelled',revision:4})],
  ['job revision',ctx=>ctx.store.put('job',{...ctx.store.get('job','job-one'),revision:4})],
  ['decision resolution',ctx=>ctx.store.put('decision',{...ctx.store.get('decision','decision-one'),state:'resolved'})],
  ['question replacement',ctx=>replaceQuestion(ctx,{name:'another-employer-field'})],
  ['actual posting bytes',ctx=>{const j=ctx.store.get('job','job-one');ctx.store.put('job',{...j,posting:{...j.posting,text:j.posting.text+' Different source text.'}});}],
  ['package hash',ctx=>ctx.store.put('package',{...ctx.store.get('package','package-one'),hash:hash('different actual version')})],
  ['profile bytes with same timestamp',ctx=>{const p=ctx.store.get('profile','main');ctx.store.db.prepare('UPDATE documents SET body=? WHERE kind=? AND id=?').run(JSON.stringify({...p,phone:'555-0199'}),'profile','main');}],
  ['source suppression',ctx=>{const f=ctx.store.list('fact').find(f=>f.text===sensor);ctx.store.put('fact',{...f,suppressed:true});}],
  ['resume source bytes',ctx=>{const r=ctx.store.get('resume','sensor-finished');ctx.store.put('resume',{...r,text:r.text+'\nChanged source bytes.'});}]
])test('an awaited model result is discarded after '+name,async t=>{
  const wait=gate(),ctx=await fixture(t,wait.run),pending=ctx.service.draft(ctx.request());
  await wait.started;mutate(ctx);wait.release();
  await assert.rejects(pending,error=>['writing_stale','writing_question','writing_context'].includes(error.code));
  assert.equal(ctx.store.list('writingDraft').length,0);assert.equal(ctx.store.get('job','job-one').writingDrafts,undefined);
});

test('duplicate concurrent requests share one call; changed notes cannot replace in-flight choices',async t=>{
  const wait=gate(),ctx=await fixture(t,wait.run),first=ctx.service.draft(ctx.request()),second=ctx.service.draft(ctx.request());
  await wait.started;await assert.rejects(ctx.service.draft(ctx.request({notes:'Different candidate choices'})),error=>error.code==='writing_busy');
  assert.equal(ctx.observed.length,1);wait.release();const [a,b]=await Promise.all([first,second]);assert.equal(a.id,b.id);assert.equal(ctx.store.list('writingDraft').length,1);
});

test('closing fences an in-flight result before any access to a closed store',async t=>{
  const wait=gate(),ctx=await fixture(t,wait.run),pending=ctx.service.draft(ctx.request());
  await wait.started;ctx.service.close();ctx.store.close();
  // The fixture teardown should not close this already closed test database.
  ctx.store.close=()=>{};wait.release();
  await assert.rejects(pending,error=>error.code==='writing_closed');
});

test('writing shares the existing persisted model budget with other reasoning',async t=>{
  const ctx=await fixture(t),campaign=ctx.store.get('campaign','main');ctx.store.put('campaign',{...campaign,rules:{maxReasoningCalls:1}});
  await ctx.service.draft(ctx.request());
  await assert.rejects(ctx.service.draft(ctx.request({notes:'Try another focus.'})),error=>error.code==='model_unavailable');
  assert.equal(ctx.store.get('usage','model').calls,1);assert.equal(ctx.observed.length,1);assert.equal(ctx.store.list('writingDraft').length,1);
});

test('candidate motivation notes and actual employer excerpts have separate visible provenance',async t=>{
  const notes='I want to learn more about signal quality.';
  const ctx=await fixture(t,input=>({sentences:[{text:notes,sourceIds:[input.sourceCatalog.find(source=>source.kind==='candidate_note').id]},{text:'Python prototype experience is preferred.',sourceIds:[input.sourceCatalog.find(source=>source.kind==='employer_posting'&&source.text==='Python prototype experience is preferred.').id]}],missingFacts:[],explanation:'Candidate choice and employer requirement are distinct.'}));
  const draft=await ctx.service.draft(ctx.request({notes}));
  assert.deepEqual(new Set(draft.sourceEvidence.map(source=>source.kind)),new Set(['candidate_note','employer_posting']));
  assert(draft.sourceEvidence.find(source=>source.kind==='candidate_note').context.includes('factual review required'));
});

test('sensitive eligibility cannot be inferred from unrelated evidence but exact candidate wording can be retained for review',async t=>{
  let supplied=false;const sensitive='I am a US citizen.';
  const ctx=await fixture(t,input=>({sentences:[{text:sensitive,sourceIds:[input.sourceCatalog.find(source=>supplied?source.kind==='candidate_note':source.kind==='profile').id]}],missingFacts:[],explanation:'Must not infer citizenship.'}));
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_grounding');
  supplied=true;const draft=await ctx.service.draft(ctx.request({notes:sensitive}));
  assert.equal(draft.text,sensitive);assert.equal(draft.reviewRequired,true);
});

test('employer text alone cannot become a first-person candidate accomplishment',async t=>{
  const ctx=await fixture(t,input=>({sentences:[{text:'I developed Python prototypes.',sourceIds:[input.sourceCatalog.find(source=>source.kind==='employer_posting').id]}],missingFacts:[],explanation:'Employer requirements are not candidate history.'}));
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_grounding');
});

test('native-structure parent phase qualifications are visible evidence and cannot disappear from a child claim',async t=>{
  let qualified=false;const quote='- Measured 12 controlled cases.';
  const ctx=await fixture(t,input=>({sentences:[sourced(input,qualified?'I evaluated an academic simulated sensor prototype across 12 controlled cases.':'The sensor prototype measured 12 controlled cases.',quote)],missingFacts:[],explanation:'The measurement belongs to the explicitly simulated academic phase.'}));
  const text='# Alex Example\n## Projects\n### Sensor prototype\nAcademic project | 2026\n#### Simulation-only phase\n'+quote+'\n## Skills\nPython\n';
  let source=ctx.store.put('resume',{id:'phase-source',name:'Phase source.md',mime:'text/markdown',text,hash:hash(text),mega:true});source=ctx.store.put('resume',{...source,structureContexts:resumeStructureContexts(source,Buffer.from(text))});
  new ResumeService({store:ctx.store,directory:ctx.store.directory}).indexFacts(source);
  await assert.rejects(ctx.service.draft(ctx.request()),error=>error.code==='writing_grounding');
  const evidence=ctx.observed[0].sourceCatalog.find(item=>item.text===quote);assert(evidence.supportingContext.some(text=>/Simulation-only phase/.test(text)));assert(evidence.contextLabel.includes('Sensor prototype'));assert(evidence.projectKey.endsWith('|sensor prototype'));
  qualified=true;const draft=await ctx.service.draft(ctx.request());assert.match(draft.text,/academic simulated sensor prototype/);assert(draft.sourceEvidence[0].supportingContext.some(text=>/Simulation-only phase/.test(text)));
});

test('legacy DOCX date fallback and a stale structured source cannot enter writing evidence',async t=>{
  const ctx=await fixture(t),line='- Evaluated a separate academic robot prototype.';
  const legacy=ctx.addResume('legacy-native','Robot prototype',line);ctx.store.put('resume',{...legacy,mime:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
  const other=ctx.addResume('stale-context','Another prototype','- Documented a simulated navigation prototype.');const map=resumeStructureContexts(other,Buffer.from(other.text));ctx.store.put('resume',{...other,structureContexts:map,hash:hash('different source fingerprint')});
  await ctx.service.draft(ctx.request());assert(!ctx.observed[0].sourceCatalog.some(item=>['legacy-native','stale-context'].includes(item.resumeId)));
});

test('large genuine evidence libraries produce a bounded catalog with actual quote context',async t=>{
  const ctx=await fixture(t);
  const letters=index=>String.fromCharCode(97+Math.floor(index/26))+String.fromCharCode(97+index%26);
  const lines=Array.from({length:200},(_,i)=>'- Documented the simulated sensor prototype '+letters(i)+' '+('signal analysis '.repeat(25))+'.');
  ctx.addResume('large-source','Sensor prototype',lines.join('\n'));
  await ctx.service.draft(ctx.request());const catalog=ctx.observed[0].sourceCatalog;
  assert(catalog.length<=48);assert(catalog.reduce((sum,source)=>sum+source.text.length,0)<=24000);
  for(const source of catalog.filter(source=>source.kind==='resume_fact'))assert(ctx.store.get('resume',source.resumeId).text.includes(source.text));
});
