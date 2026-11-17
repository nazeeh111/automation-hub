import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

// Actual local API/worker/comparison boundary. Provider and posting transport
// are synthetic; campaign enablement and employer dispatch are forbidden.
const Q='Which availability should guide this application?',ANSWER='June 2027';
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-reasoning-context-'));let version=1,release,entered,held=false,submissions=0,inspectHeld=false,inspectEntered,inspectRelease;const calls=[];
 const posting=()=>({title:'Synthetic engineering internship',employer:'Synthetic Labs',portal:'lever',open:true,text:'Python preferred. Posting version '+version,sourceHash:'context-posting-'+version,sourceUrl:'https://jobs.lever.co/synthetic/context',requirements:[]});
 const hub=await createHub({directory,port:0,open:false,modelRunner:async input=>{calls.push(structuredClone(input));if(held){entered();await new Promise(resolve=>release=resolve);}return {chosenResumeId:input.resumes[0].id,explanation:'Controlled comparison of supplied source.',edits:[],structureEdits:[],requirements:[],questions:input.scopedAnswers[Q]?[]:[{question:Q,reason:'Use only the current candidate clarification.',options:[ANSWER,'July 2027']}]};},engineAdapter:{readiness:async()=>({id:'browser',status:'limited'}),inspect:async()=>{if(inspectHeld){inspectEntered();await new Promise(resolve=>inspectRelease=resolve);}return posting();},close:async()=>{},submit:async()=>{submissions++;throw new Error('Forbidden dispatch');}},discoveryOptions:{fetcher:async()=>{throw new Error('Forbidden external read');}}});
 const ctx=hub.context(false);clearInterval(ctx.engine.timer);ctx.engine.timer=null;
 t.after(async()=>{release?.();inspectRelease?.();try{assert.equal(ctx.store.get('campaign','main').enabled,false);assert.equal(ctx.store.list('run').length,0);assert.equal(submissions,0);}finally{await hub.close();await rm(directory,{recursive:true,force:true});}});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const request=async(endpoint,body)=>{const response=await fetch(hub.baseUrl+endpoint,{method:'POST',headers:{Cookie:cookie,Origin:hub.baseUrl,'X-Hub-Workspace':'real','Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});return {status:response.status,value:await response.json()};};
 const action=body=>request('/api/action',body);
 await action({action:'saveProfile',profile:{fullName:'Synthetic Candidate',email:'synthetic@example.invalid',availability:ANSWER}});
 const document=name=>({name,content:Buffer.from('# Synthetic Candidate\n\n## Projects\n### Controlled simulation '+name+'\n- Built a simulated Python sensor in controlled tests.\n\n## Skills\nPython\n').toString('base64')});
 assert.equal((await request('/api/import/resumes',{files:[document('Finished.md')]})).value.imported,1);
 assert.equal((await request('/api/import/jobs',{text:'https://jobs.lever.co/synthetic/context'})).value.imported,1);
 ctx.store.put('connection',{id:'model',enabled:true,verified:true});const jobId=ctx.store.list('job')[0].id;
 const job=()=>ctx.store.get('job',jobId),decisions=()=>ctx.store.list('decision').filter(item=>item.type==='missing_fact');
 const prepare=async()=>{const queued=await action({action:'prepare',jobId});assert.equal(queued.status,200,JSON.stringify(queued.value));return ctx.engine.tick();};
 const mutate=async kind=>{if(kind==='profile')assert.equal((await action({action:'saveProfile',profile:{availability:'July 2027'}})).status,200);else if(kind==='corpus')assert.equal((await request('/api/import/resumes',{files:[{...document('New evidence.md'),mega:true}]})).value.imported,1);else{version++;ctx.engine.postings.record(job(),posting(),{reason:'pre_dispatch'});}};
 return {ctx,calls,action,request,job,jobId,decisions,prepare,mutate,async hold(){held=true;const waiting=new Promise(resolve=>entered=resolve);const pending=prepare();await waiting;return {pending,release:()=>{held=false;release();}};},async holdInspect(){inspectHeld=true;const waiting=new Promise(resolve=>inspectEntered=resolve);const pending=prepare();await waiting;return {pending,release:()=>{inspectHeld=false;inspectRelease();}};}};
}
test('a current clarification is accepted, forwarded once and prepares a verified current package',async t=>{
 const f=await fixture(t);await f.prepare();const d=f.decisions()[0];assert(d.reasoningBinding);assert.deepEqual(f.calls[0].scopedAnswers,{});
 assert.equal((await f.action({action:'resolveDecision',decisionId:d.id,answer:ANSWER})).status,200);await f.ctx.engine.tick();assert.equal(f.calls[1].scopedAnswers[Q],ANSWER);
 const pkg=f.ctx.store.get('package',f.job().packageId);assert.equal(pkg.verified,true);assert.equal(pkg.profileRevision,f.ctx.store.get('profile','main').updatedAt);assert.equal(pkg.postingBinding.sourceHash,f.job().posting.sourceHash);
});
for(const kind of ['profile','posting','corpus'])test(`${kind} change rejects an old decision with no durable effect and explicit prepare regenerates safely`,async t=>{
 const f=await fixture(t);await f.prepare();const old=f.decisions()[0];await f.mutate(kind);const before={revision:f.ctx.store.revision(),job:f.job(),decision:f.ctx.store.get('decision',old.id),calls:f.calls.length};
 const rejected=await f.action({action:'resolveDecision',decisionId:old.id,answer:ANSWER});assert.equal(rejected.status,409);assert.equal(f.ctx.store.revision(),before.revision);assert.deepEqual(f.job(),before.job);assert.deepEqual(f.ctx.store.get('decision',old.id),before.decision);assert.equal(f.calls.length,before.calls);
 await f.prepare();const current=f.decisions().find(d=>d.state==='open');assert(current);assert.notEqual(current.id,old.id);assert.equal(f.ctx.store.get('decision',old.id).state,'superseded');assert.equal(f.ctx.store.get('decision',old.id).question,old.question);assert.deepEqual(f.calls.at(-1).scopedAnswers,{});
 assert.equal((await f.action({action:'resolveDecision',decisionId:current.id,answer:'July 2027'})).status,200);await f.ctx.engine.tick();assert.equal(f.calls.at(-1).scopedAnswers[Q],'July 2027');assert(f.job().packageId);
});
for(const kind of ['profile','posting','corpus'])test(`${kind} change excludes a previously accepted answer from the next actual model request`,async t=>{
 const f=await fixture(t);await f.prepare();const old=f.decisions()[0];assert.equal((await f.action({action:'resolveDecision',decisionId:old.id,answer:ANSWER})).status,200);await f.mutate(kind);await f.ctx.engine.tick();
 assert.deepEqual(f.calls.at(-1).scopedAnswers,{});assert.equal(f.job().reasoningAnswers[Q],ANSWER);assert.equal(f.ctx.store.get('decision',old.id).answer,ANSWER);assert.equal(f.ctx.store.get('decision',old.id).state,'resolved');assert.equal(f.ctx.store.list('package').length,0);assert(f.decisions().some(d=>d.state==='open'&&d.id!==old.id));
});
for(const kind of ['profile','posting','corpus'])test(`${kind} change during an awaited comparison cannot publish its stale question`,async t=>{
 const f=await fixture(t),held=await f.hold();await f.mutate(kind);held.release();await held.pending;assert.equal(f.calls.length,1);assert.equal(f.decisions().length,0);assert.equal(f.ctx.store.list('package').length,0);
});
test('unbound legacy answers and decisions are retained but never forwarded or accepted',async t=>{
 const f=await fixture(t);f.ctx.store.put('job',{...f.job(),reasoningAnswers:{[Q]:'Legacy plaintext'}});f.ctx.store.put('decision',{id:'legacy',jobId:f.jobId,type:'missing_fact',state:'open',question:Q});const before=f.ctx.store.revision();assert.equal((await f.action({action:'resolveDecision',decisionId:'legacy',answer:ANSWER})).status,409);assert.equal(f.ctx.store.revision(),before);
 await f.prepare();assert.deepEqual(f.calls[0].scopedAnswers,{});assert.equal(f.job().reasoningAnswers[Q],'Legacy plaintext');assert.equal(f.ctx.store.get('decision','legacy').state,'superseded');
});
test('explicit preparation cannot discard another current question or release manual control',async t=>{
 const f=await fixture(t);await f.prepare();await f.mutate('profile');f.ctx.store.put('decision',{id:'other-current',jobId:f.jobId,code:'form_questions',state:'open',details:{questions:[{label:'Current employer question'}]}});let revision=f.ctx.store.revision();assert.equal((await f.action({action:'prepare',jobId:f.jobId})).status,409);assert.equal(f.ctx.store.revision(),revision);assert.equal(f.decisions()[0].state,'open');
 f.ctx.store.put('job',{...f.job(),state:'manual',preparationRequested:false});revision=f.ctx.store.revision();assert.equal((await f.action({action:'prepare',jobId:f.jobId})).status,409);assert.equal(f.ctx.store.revision(),revision);assert.equal(f.job().state,'manual');assert.equal(f.job().preparationRequested,false);
});
test('profile change during a posting read spends no model call and requires fresh explicit preparation',async t=>{
 const f=await fixture(t),held=await f.holdInspect();await f.mutate('profile');held.release();await held.pending;
 assert.equal(f.calls.length,0);assert.equal(f.decisions().length,0);assert.equal(f.ctx.store.list('postingObservation').length,0);assert.equal(f.ctx.store.list('package').length,0);assert.equal(f.ctx.store.get('usage','model'),null);assert.equal(f.job().preparationRequested,false);
 await f.prepare();assert.equal(f.calls.length,1);assert.equal(f.calls[0].profile.availability,'July 2027');assert.equal(f.decisions().filter(d=>d.state==='open').length,1);
});
test('a repeated clarification after an insufficient answer keeps the original answer history',async t=>{
 const f=await fixture(t);await f.prepare();const old=f.decisions()[0];assert.equal((await f.action({action:'resolveDecision',decisionId:old.id,answer:'None'})).status,200);
 f.ctx.model.runner=async input=>({chosenResumeId:input.resumes[0].id,explanation:'The supplied answer did not resolve this exact clarification.',edits:[],structureEdits:[],requirements:[],questions:[{question:Q,reason:'Use only the current candidate clarification.',options:[ANSWER,'July 2027']}]});await f.ctx.engine.tick();
 const current=f.decisions().find(decision=>decision.state==='open');assert(current);assert.notEqual(current.id,old.id);assert.equal(f.ctx.store.get('decision',old.id).state,'resolved');assert.equal(f.ctx.store.get('decision',old.id).answer,'None');assert.equal((await f.action({action:'resolveDecision',decisionId:current.id,answer:ANSWER})).status,200);assert.equal(f.job().reasoningAnswers[Q],ANSWER);
});
test('profile change during prior-submission lookup publishes no clarification and needs fresh preparation',async t=>{
 const f=await fixture(t);let entered,release;const waiting=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 f.ctx.engine.priorSubmissionResolver=async()=>{entered();await gate;return {status:'synthetic_local_history_only'};};t.after(()=>release());
 const pending=f.prepare();await waiting;await f.mutate('profile');release();await pending;
 assert.equal(f.calls.length,0);assert.equal(f.decisions().length,0);assert.equal(f.ctx.store.list('package').length,0);assert.equal(f.ctx.store.get('usage','model'),null);assert.equal(f.job().reasoningAnswers,undefined);assert.equal(f.job().priorApplicationCheck,undefined);assert.equal(f.job().preparationRequested,false);
 await f.prepare();assert.equal(f.calls.length,1);assert.equal(f.calls[0].profile.availability,'July 2027');const decision=f.decisions().find(item=>item.state==='open');assert(decision);assert.equal((await f.action({action:'resolveDecision',decisionId:decision.id,answer:'July 2027'})).status,200);assert.equal(f.job().reasoningAnswers[Q],'July 2027');
});

test('a failed outcome record rolls back both application and question changes and preserves current answer recovery',async t=>{
 const f=await fixture(t);await f.prepare();const decision=f.decisions()[0],put=f.ctx.store.put.bind(f.ctx.store),before={job:f.job(),decision:f.ctx.store.get('decision',decision.id),revision:f.ctx.store.revision(),calls:f.calls.length};let injected=false;
 f.ctx.store.put=(kind,value)=>{if(!injected&&kind==='decision'&&value.id===decision.id&&value.state==='resolved'){injected=true;throw new Error('Synthetic storage failure between retained outcome and decision closure');}return put(kind,value);};
 let outcome;try{outcome=await f.action({action:'recordOutcome',jobId:f.jobId,outcome:'interview',evidence:{url:f.job().url,reference:'synthetic-recovery-receipt',employer:f.job().employer,title:f.job().title,email:f.ctx.store.get('profile','main').email}});}finally{f.ctx.store.put=put;}
 assert(injected);assert.equal(outcome.status,400);assert.deepEqual(f.job(),before.job);assert.deepEqual(f.ctx.store.get('decision',decision.id),before.decision);assert.equal(f.ctx.store.revision(),before.revision);assert.equal(f.calls.length,before.calls);
 assert.equal((await f.action({action:'resolveDecision',decisionId:decision.id,answer:ANSWER})).status,200);assert.equal(f.job().state,'imported');assert.equal(f.calls.length,before.calls);
});

for(const state of ['preparing','applying','uncertain','submitted','interview','assessment','rejected','offer','closed','cancelled'])test(`a retained open clarification cannot reopen ${state} application work`,async t=>{
 const f=await fixture(t);await f.prepare();const decision=f.decisions()[0];f.ctx.store.put('job',{...f.job(),state,preparationRequested:false});const revision=f.ctx.store.revision(),before=f.job();
 assert.equal((await f.action({action:'resolveDecision',decisionId:decision.id,answer:ANSWER})).status,409);assert.equal(f.ctx.store.revision(),revision);assert.deepEqual(f.job(),before);assert.equal(f.ctx.store.get('decision',decision.id).state,'open');assert.equal(f.calls.length,1);
});
test('a current manual clarification can save its answer without returning execution control',async t=>{
 const f=await fixture(t);await f.prepare();const decision=f.decisions()[0];assert.equal((await f.action({action:'takeover',jobId:f.jobId})).status,200);assert.equal((await f.action({action:'resolveDecision',decisionId:decision.id,answer:ANSWER})).status,200);assert.equal(f.job().state,'manual');assert.equal(f.job().preparationRequested,false);assert.equal(f.calls.length,1);assert.equal(f.ctx.store.get('decision',decision.id).state,'resolved');assert.equal(f.ctx.store.get('decision',decision.id).answer,ANSWER);assert.equal(f.job().reasoningAnswers[Q],ANSWER);
});
test('legacy retained receipt evidence protects an application even without its convenience state and marker',async t=>{
 const f=await fixture(t);await f.prepare();const decision=f.decisions()[0],profile=f.ctx.store.get('profile','main'),job=f.job();f.ctx.store.put('job',{...job,state:'needs_you',submissionConfirmation:null,evidence:[{id:'synthetic-legacy-receipt',type:'candidate_attested_receipt',outcome:'interview',jobId:job.id,identity:job.identity,candidateId:profile.id||'main',email:profile.email,title:job.title,employer:job.employer,observedAt:new Date().toISOString()}]});const before=f.job(),revision=f.ctx.store.revision();
 assert.equal((await f.action({action:'resolveDecision',decisionId:decision.id,answer:ANSWER})).status,409);assert.deepEqual(f.job(),before);assert.equal(f.ctx.store.revision(),revision);assert.equal(f.calls.length,1);
});
test('a retained dispatched attempt protects an earlier open clarification without a terminal job label',async t=>{
 const f=await fixture(t);await f.prepare();const decision=f.decisions()[0];f.ctx.store.put('run',{id:'synthetic-dispatched',jobId:f.jobId,state:'uncertain',dispatchedAt:new Date().toISOString()});f.ctx.store.put('job',{...f.job(),state:'needs_you',activeAttemptId:'synthetic-dispatched'});const before=f.job(),revision=f.ctx.store.revision();
 assert.equal((await f.action({action:'resolveDecision',decisionId:decision.id,answer:ANSWER})).status,409);assert.deepEqual(f.job(),before);assert.equal(f.ctx.store.revision(),revision);assert.equal(f.calls.length,1);f.ctx.store.remove('run','synthetic-dispatched');
});

for(const state of ['imported','failed','ready'])test(`a current clarification in compatible ${state} recovery saves both records`,async t=>{
 const f=await fixture(t);await f.prepare();const decision=f.decisions()[0];f.ctx.store.put('job',{...f.job(),state});assert.equal((await f.action({action:'resolveDecision',decisionId:decision.id,answer:ANSWER})).status,200);assert.equal(f.ctx.store.get('decision',decision.id).state,'resolved');assert.equal(f.ctx.store.get('decision',decision.id).answer,ANSWER);assert.equal(f.job().state,'imported');assert.equal(f.job().preparationRequested,true);assert.equal(f.job().reasoningAnswers[Q],ANSWER);assert(f.job().reasoningAnswerBindings[Q]);assert.equal(f.calls.length,1);
});
for(const authority of ['priorApplicationDetected','employer_confirmed','candidate_attested','fixture'])test(`a current clarification preserves retained ${authority} authority`,async t=>{
 const f=await fixture(t);await f.prepare();const decision=f.decisions()[0];f.ctx.store.put('job',{...f.job(),...(authority==='priorApplicationDetected'?{priorApplicationDetected:true}:{submissionConfirmation:authority})});const before={job:f.job(),decision:f.ctx.store.get('decision',decision.id),revision:f.ctx.store.revision(),events:f.ctx.store.list('event')};assert.equal((await f.action({action:'resolveDecision',decisionId:decision.id,answer:ANSWER})).status,409);assert.deepEqual(f.job(),before.job);assert.deepEqual(f.ctx.store.get('decision',decision.id),before.decision);assert.deepEqual(f.ctx.store.list('event'),before.events);assert.equal(f.ctx.store.revision(),before.revision);assert.equal(f.calls.length,1);
});
for(const outcome of ['submitted','interview','assessment','rejected','offer','closed'])test(`recording ${outcome} commits the receipt, clarification closure and history together`,async t=>{
 const f=await fixture(t);await f.prepare();const decision=f.decisions()[0],events=f.ctx.store.list('event'),job=f.job(),email=f.ctx.store.get('profile','main').email,receipt={url:job.url,reference:'synthetic-'+outcome,employer:job.employer,title:job.title,email};assert.equal((await f.action({action:'recordOutcome',jobId:f.jobId,outcome,evidence:receipt})).status,200);const saved=f.job(),closed=f.ctx.store.get('decision',decision.id),evidence=saved.evidence.at(-1),after=f.ctx.store.list('event'),event=after.find(e=>e.type==='outcome_recorded'&&e.payload.evidenceId===evidence.id);
 assert.equal(saved.state,outcome);assert.equal(saved.submissionConfirmation,'candidate_attested');for(const [key,value] of Object.entries(receipt))assert.equal(evidence[key],value);assert.equal(evidence.outcome,outcome);assert.equal(evidence.type,'candidate_attested_receipt');assert.equal(evidence.jobId,job.id);assert.equal(evidence.identity,job.identity);assert.equal(evidence.documentsVerified,false);assert.equal(closed.state,'resolved');assert.equal(closed.answer,'Receipt recorded');assert.equal(closed.question,decision.question);assert.deepEqual(closed.reasoningBinding,decision.reasoningBinding);assert(event);assert.equal(event.applicationId,job.id);assert.equal(event.payload.outcome,outcome);assert.equal(event.payload.source,'candidate_attested');assert.equal(after.length,events.length+1);for(const e of events)assert.deepEqual(after.find(x=>x.id===e.id),e);assert.equal(f.calls.length,1);
});
test('answering one current clarification preserves the other open question and disables preparation',async t=>{
 const f=await fixture(t),runner=f.ctx.model.runner;f.ctx.model.runner=async input=>{const result=await runner(input);return {...result,questions:[...result.questions,{question:'Which relocation availability should guide this application?',reason:'Use only the current relocation clarification.',options:['Available','Not available']}]};};await f.prepare();const questions=f.decisions();assert.equal(questions.length,2);const first=questions.find(d=>d.question===Q),other=questions.find(d=>d.id!==first.id);assert.equal((await f.action({action:'resolveDecision',decisionId:first.id,answer:ANSWER})).status,200);assert.equal(f.ctx.store.get('decision',first.id).state,'resolved');assert.equal(f.ctx.store.get('decision',first.id).answer,ANSWER);assert.deepEqual(f.ctx.store.get('decision',other.id),other);assert.equal(f.job().state,'needs_you');assert.equal(f.job().preparationRequested,false);assert.equal(f.job().reasoningAnswers[Q],ANSWER);assert.equal(f.calls.length,1);
});

test('event-write failure rolls back outcome, every linked decision, history and revision',async t=>{
 const f=await fixture(t);await f.prepare();f.ctx.store.put('decision',{id:'related-owner-question',jobId:f.jobId,code:'current-extra-question',state:'open',details:{}});const before={job:f.job(),decisions:f.ctx.store.list('decision'),events:f.ctx.store.list('event'),revision:f.ctx.store.revision()},put=f.ctx.store.put.bind(f.ctx.store);let injected=false;
 f.ctx.store.put=(kind,value)=>{if(kind==='event'&&value.type==='outcome_recorded'){injected=true;throw new Error('Synthetic final history write failure');}return put(kind,value);};let result;try{result=await f.action({action:'recordOutcome',jobId:f.jobId,outcome:'interview',evidence:{url:f.job().url,reference:'synthetic-final-event',employer:f.job().employer,title:f.job().title,email:f.ctx.store.get('profile','main').email}});}finally{f.ctx.store.put=put;}
 assert(injected);assert.equal(result.status,400);assert.deepEqual(f.job(),before.job);assert.deepEqual(f.ctx.store.list('decision'),before.decisions);assert.deepEqual(f.ctx.store.list('event'),before.events);assert.equal(f.ctx.store.revision(),before.revision);assert.equal(f.calls.length,1);
});
