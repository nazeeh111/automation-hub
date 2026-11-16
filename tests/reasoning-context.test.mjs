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
