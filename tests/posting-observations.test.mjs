import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {Engine} from '../server/engine.mjs';
import {ResumeService,hash} from '../server/resumes.mjs';
import {createHub} from '../server/index.mjs';
import {PostingObservations,POSTING_OBSERVATION_LIMITS} from '../server/posting-observations.mjs';

// Regression: SOURCE-001 — changed posting evidence and exact package context.
// Found by /qa on 2026-11-16.
// Report: docs/product-depth-2026-11-16/workflow/REPORT.md
const posting=(version='A',extra={})=>({title:'Engineering intern',employer:'Synthetic Labs',text:`Version ${version}. Python experience is preferred.`,requirements:[],open:true,sourceHash:`posting-${version}`,sourceUrl:'https://jobs.lever.co/synthetic/role',observedAt:'2026-11-16T12:00:00Z',...extra});
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-posting-observations-')),store=new Store(directory);
 const profile=store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:'synthetic@example.test',answers:{}});store.put('resume',{id:'source',mega:false});
 const job=store.put('job',{id:'job',identity:'main|lever:us:synthetic|role|',url:posting().sourceUrl,title:posting().title,employer:posting().employer,state:'imported',revision:0,posting:posting()});
 let current=posting(),failure=null,counter=0,dispatches=0,inspectGate=null;
 const resumes={assertPackageCurrent(){},prepare:async job=>{if(failure)throw failure;return {id:`package-${++counter}`,jobId:job.id,resumeId:'source',verified:true,approved:true,profileRevision:profile.updatedAt,hash:'synthetic-pdf',finalPath:'/synthetic-never-opened.pdf',requirements:[],sources:[]};}};
 const engine=new Engine({store,directory,resumes,adapter:{inspect:async()=>{if(inspectGate)await inspectGate;return structuredClone(current);},submit:async()=>{dispatches++;throw new Error('No external submission is allowed');},close:async()=>{}}});
 t.after(async()=>{await engine.stop();store.close();await rm(directory,{recursive:true,force:true});});
 return {store,engine,directory,profile,job,setPosting:value=>current=value,setFailure:value=>failure=value,setGate:value=>inspectGate=value,dispatches:()=>dispatches,prepare:()=>engine.prepare(store.get('job',job.id),store.get('campaign','main')),syntheticEnable:()=>store.put('campaign',{...store.get('campaign','main'),enabled:true,status:'running',profileRevision:profile.updatedAt,rules:{maxApplications:10,maxPerEmployer:3,maxReasoningCalls:20,allowedHosts:['jobs.lever.co']}})};
}

test('changed pre-submit posting is retained before yielding, with original package source intact and zero dispatch',async t=>{
 const f=await fixture(t);await f.prepare();const oldJob=f.store.get('job','job'),pkg=f.store.get('package',oldJob.packageId);
 assert.equal(pkg.postingBinding?.sourceHash,'posting-A');f.setPosting(posting('B'));await f.engine.apply(oldJob,f.syntheticEnable());
 const job=f.store.get('job','job'),observations=f.store.list('postingObservation');
 assert.equal(observations.length,2);assert.equal(job.posting.sourceHash,'posting-A');assert.equal(job.postingObservationId,pkg.postingBinding.observationId);assert.notEqual(job.latestPostingObservationId,job.postingObservationId);
 assert.equal(observations.find(item=>item.id===job.latestPostingObservationId).posting.text,posting('B').text);
 const decision=f.store.list('decision').find(item=>item.state==='open');assert.equal(decision.code,'posting_changed');assert.equal(decision.details.latestObservationId,job.latestPostingObservationId);assert.equal(f.dispatches(),0);assert.equal(f.store.list('run').length,0);
 assert.throws(()=>f.engine.reviewPackage({packageId:pkg.id,approved:true}),/posting|source/i);
});

test('failed reprepare preserves both postings and refuses approval of the prior source package',async t=>{
 const f=await fixture(t);await f.prepare();const pkg=f.store.get('package',f.store.get('job','job').packageId),original=JSON.stringify(pkg);
 f.setPosting(posting('B'));f.setFailure(Object.assign(new Error('Synthetic reasoning unavailable'),{code:'model_unavailable'}));
 await f.engine.action('prepare',{jobId:'job'});await f.prepare();const job=f.store.get('job','job');
 assert.equal(job.state,'needs_you');assert.equal(job.posting.sourceHash,'posting-B');assert.equal(job.packageId,pkg.id);assert.equal(f.store.list('postingObservation').length,2);assert.equal(JSON.stringify(f.store.get('package',pkg.id)),original);
 assert.throws(()=>f.engine.reviewPackage({packageId:pkg.id,approved:true}),/posting|source/i);assert.equal(f.dispatches(),0);
});

test('late posting read loses ownership to manual takeover and cannot retain or adopt its result',async t=>{
 const f=await fixture(t);await f.prepare();let release;const gate=new Promise(resolve=>release=resolve);f.setGate(gate);f.setPosting(posting('B'));
 await f.engine.action('prepare',{jobId:'job'});const work=f.prepare();await new Promise(resolve=>setImmediate(resolve));await f.engine.action('takeover',{jobId:'job'});const owned=f.store.get('job','job'),snapshots=f.store.list('postingObservation');release();await work;
 assert.deepEqual(f.store.get('job','job'),owned);assert.deepEqual(f.store.list('postingObservation'),snapshots);assert.equal(f.dispatches(),0);
});

test('same source read deduplicates timestamps, while source hash changes outside retained text remain distinct',async t=>{
 const f=await fixture(t);await f.prepare();const first=f.store.list('postingObservation')[0];assert(first);
 f.setPosting(posting('A',{observedAt:'2026-11-16T13:00:00Z'}));await f.engine.action('prepare',{jobId:'job'});await f.prepare();assert.equal(f.store.list('postingObservation').length,1);
 f.setPosting(posting('A',{sourceHash:'different-full-source-hash',observedAt:'2026-11-16T14:00:00Z'}));await f.engine.action('prepare',{jobId:'job'});await f.prepare();const second=f.store.list('postingObservation').find(item=>item.id!==first.id);
 assert(second);assert.notEqual(first.sourceHash,second.sourceHash);assert.equal(first.contentHash,second.contentHash);assert.equal(first.posting.text,second.posting.text);
});

test('legacy unbound package stays retained but cannot be approved or dispatched as a current source version',async t=>{
 const f=await fixture(t),legacy=f.store.put('package',{id:'legacy',jobId:'job',verified:true,approved:true,profileRevision:f.profile.updatedAt,hash:'legacy',requirements:[]});f.store.put('job',{...f.store.get('job','job'),state:'ready',packageId:legacy.id});
 assert.throws(()=>f.engine.reviewPackage({packageId:legacy.id,approved:true}),/posting|source/i);
 await f.engine.apply(f.store.get('job','job'),f.syntheticEnable());assert.equal(f.dispatches(),0);assert.equal(f.store.list('run').length,0);assert.deepEqual(f.store.get('package',legacy.id),legacy);
});

test('actual finished-original selection binds a rendered package to the retained posting source',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-actual-posting-package-')),store=new Store(directory),resumes=new ResumeService({store,directory,model:null});t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:'synthetic@example.test',answers:{}});const job=store.put('job',{id:'actual-job',identity:'main|lever:us:synthetic|role|',url:posting().sourceUrl,title:posting().title,employer:posting().employer,state:'needs_you',revision:0,posting:posting()});
 const result=await resumes.import([{name:'Finished synthetic resume.md',content:Buffer.from('# Synthetic Candidate\n\n## Projects\n### Controlled simulation\n- Built a simulated sensor prototype in Python.\n\n## Skills\nPython').toString('base64')}]);assert.deepEqual(result.errors,[]);
 const pkg=await resumes.select(job,store.list('resume')[0].id);assert.equal(pkg.postingBinding.sourceHash,'posting-A');assert.equal(pkg.postingBinding.jobIdentity,job.identity);assert.equal(pkg.postingBinding.observationId,store.get('job',job.id).postingObservationId);assert.equal(pkg.postingBinding.contentHash,store.get('postingObservation',pkg.postingBinding.observationId).contentHash);assert.equal(pkg.verified,true);
});

test('posting observations are immutable, retained on failure and bounded before recording another source',async t=>{
 const f=await fixture(t);await f.prepare();const first=f.store.list('postingObservation')[0];
 assert.throws(()=>f.store.put('postingObservation',{...first,posting:posting('forged')}),/immutable/);assert.throws(()=>f.store.remove('postingObservation',first.id),/history/);
 const service=f.engine.postings;
 for(let i=1;i<POSTING_OBSERVATION_LIMITS.perJob;i++)service.record(f.store.get('job','job'),posting(String(i)),{adopt:false});
 const original=f.store.list('postingObservation'),job=f.store.get('job','job');assert.throws(()=>service.record(job,posting('over-limit')),e=>e.code==='posting_history_limit');assert.deepEqual(f.store.list('postingObservation'),original);assert.deepEqual(f.store.get('job','job'),job);
 assert.throws(()=>service.record(job,posting('too-long',{text:'x'.repeat(POSTING_OBSERVATION_LIMITS.text+1)})),e=>e.code==='posting_source_limit');assert.deepEqual(f.store.list('postingObservation'),original);
});

test('stale same-revision source context cannot replace current observation references',async t=>{
 const f=await fixture(t);await f.prepare();const stale=f.store.get('job','job');
 const current=f.store.put('job',{...stale,posting:posting('corrected')});
 assert.throws(()=>f.engine.postings.record(stale,posting('delayed'),{adopt:true}),e=>e.code==='action_revoked');assert.deepEqual(f.store.get('job','job'),current);
});

async function apiFixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-posting-api-'));let observed=posting(),prepared=0,hold=false;
 const hub=await createHub({directory,port:0,engineAdapter:{readiness:async()=>({id:'browser',status:'ready',detail:'Synthetic adapter only'}),inspect:async()=>structuredClone(observed),submit:async()=>{throw new Error('Submission forbidden');},close:async()=>{}}}),ctx=hub.context(false),store=ctx.store;
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});
 store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:'synthetic@example.test',answers:{}});store.put('resume',{id:'source',mega:false});
 store.put('job',{id:'job',identity:'main|lever:us:synthetic|role|',url:posting().sourceUrl,title:posting().title,employer:posting().employer,state:'imported',revision:0});
 ctx.resumes.prepare=async job=>{if(hold)throw Object.assign(new Error('Synthetic comparison unavailable'),{code:'model_unavailable'});return {id:`api-package-${++prepared}`,jobId:job.id,resumeId:'source',verified:true,approved:false,hash:'synthetic-hash',finalPath:'/synthetic-never-opened.pdf',requirements:[],sources:[]};};
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0];
 const request=async(route,{body,workspace='real',authenticated=true}={})=>{const response=await fetch(hub.baseUrl+route,{method:body?'POST':'GET',headers:{...(authenticated?{Cookie:cookie}:{}),'X-Hub-Workspace':workspace,...(body?{Origin:hub.baseUrl,'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json()};};
 return {hub,ctx,store,request,setObserved:value=>observed=value,setHold:()=>hold=true,prepare:()=>ctx.engine.prepare(store.get('job','job'),store.get('campaign','main'))};
}

test('posting API returns exact prepared source even beyond latest two observations and keeps bodies off state',async t=>{
 const f=await apiFixture(t);await f.prepare();const original=f.store.get('package',f.store.get('job','job').packageId);f.setHold();
 for(const version of ['B','C','D']){f.setObserved(posting(version));await f.prepare();}
 const page=await f.request('/api/jobs/job/postings?limit=2');assert.equal(page.status,200);assert.equal(page.body.observations.length,2);assert.equal(page.body.hasMore,true);assert.equal(page.body.latestObservation.sourceHash,'posting-D');assert.equal(page.body.currentObservation.sourceHash,'posting-D');assert.equal(page.body.packageObservation.sourceHash,'posting-A');assert.equal(page.body.packageObservation.id,original.postingBinding.observationId);assert.equal(page.body.comparison.sourceChanged,true);assert.equal(page.body.comparison.retainedTextChanged,true);
 const older=await f.request('/api/jobs/job/postings?'+new URLSearchParams({before:page.body.nextCursor,limit:'2'}));assert.equal(older.status,200);assert.deepEqual(older.body.observations.map(item=>item.sourceHash),['posting-B','posting-A']);assert.equal(older.body.hasMore,false);assert.equal(older.body.nextCursor,null);
 const state=(await f.request('/api/state')).body;assert.equal(Object.hasOwn(state,'postingObservations'),false);assert.equal(Object.hasOwn(state.packages[0],'postingSnapshot'),false);assert.equal(typeof state.packages[0].postingBinding.contentHash,'string');
 const exported=(await f.request('/api/export')).body;assert.equal(exported.postingObservation.length,4);
});

test('posting API enforces query, cursor, job, auth and real-fixture scope without writes',async t=>{
 const f=await apiFixture(t);await f.prepare();f.setObserved(posting('B'));await f.prepare();const first=await f.request('/api/jobs/job/postings?limit=1'),revision=f.store.revision();
 assert.equal((await f.request('/api/jobs/job/postings',{authenticated:false})).status,401);assert.equal((await f.request('/api/jobs/missing/postings')).status,404);
 for(const query of ['limit=0','limit=101','limit=1.5','limit=1&limit=2','kind=profile','before=','before=e30','before=garbage'])assert.equal((await f.request('/api/jobs/job/postings?'+query)).status,400,query);
 assert.equal((await f.request('/api/jobs/job/postings',{workspace:''})).status,400);assert.equal((await f.request('/api/jobs/job/postings',{workspace:'fixture'})).status,409);assert.equal(f.store.revision(),revision);
 f.store.put('job',{...f.store.get('job','job'),id:'other-job',identity:'other-identity'});assert.equal((await f.request('/api/jobs/other-job/postings?'+new URLSearchParams({before:first.body.nextCursor}))).status,400);
 const fixture=f.hub.context(true),real=f.store.get('job','job');fixture.store.put('job',{...real,postingObservationId:undefined,latestPostingObservationId:undefined});
 assert.equal((await f.request('/api/demo',{body:{enabled:true}})).status,200);assert.equal((await f.request('/api/jobs/job/postings')).status,409);assert.equal((await f.request('/api/jobs/job/postings?'+new URLSearchParams({before:first.body.nextCursor}),{workspace:'fixture'})).status,400);
});

test('selecting a finished original before a posting read queues inspection and needs no model for unchanged reuse',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-manual-source-read-'));let reads=0,modelCalls=0;
 const hub=await createHub({directory,port:0,modelRunner:async()=>{modelCalls++;throw new Error('No reasoning is needed');},engineAdapter:{readiness:async()=>({id:'browser',status:'ready',detail:'Synthetic adapter only'}),inspect:async()=>{reads++;return posting();},submit:async()=>{throw new Error('No application allowed');},close:async()=>{}}});
 t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});const ctx=hub.context(false),store=ctx.store;
 store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:'synthetic@example.test',answers:{}});
 const imported=await ctx.resumes.import([{name:'Finished synthetic.md',content:Buffer.from('# Synthetic Candidate\n\n## Skills\nPython\n\n## Projects\n### Sensor prototype\n- Built a simulated sensor prototype in Python.').toString('base64')}]);assert.deepEqual(imported.errors,[]);const resume=store.list('resume')[0];
 store.put('job',{id:'manual-job',identity:'main|lever:us:synthetic|manual|',url:posting().sourceUrl,title:posting().title,employer:posting().employer,state:'imported',revision:0});
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0],response=await fetch(hub.baseUrl+'/api/action',{method:'POST',headers:{Cookie:cookie,Origin:hub.baseUrl,'Content-Type':'application/json','X-Hub-Workspace':'real'},body:JSON.stringify({action:'selectResume',jobId:'manual-job',resumeId:resume.id})});const result=await response.json();assert.equal(response.status,200);assert.equal(result.queued,true);assert.equal(reads,0);assert.equal(store.get('job','manual-job').selectedResumeId,resume.id);
 await ctx.engine.tick();const current=store.get('job','manual-job'),pkg=store.get('package',current.packageId);assert.equal(reads,1);assert.equal(modelCalls,0);assert.equal(store.get('campaign','main').enabled,false);assert.equal(pkg.postingBinding.sourceHash,'posting-A');assert.equal(pkg.verified,true);assert.equal(pkg.approved,false);assert.equal(store.list('run').length,0);
});

test('invalid manual résumé selection cannot replace the prior package or resolve a source hold before inspection',async t=>{
 const f=await apiFixture(t);f.store.put('resume',{id:'mega-source',mega:true});f.store.put('package',{id:'retained-package',jobId:'job',verified:true});
 const job=f.store.put('job',{...f.store.get('job','job'),state:'needs_you',selectedResumeId:'source',packageId:'retained-package'}),decision=f.store.put('decision',{id:'source-hold',jobId:'job',state:'open',code:'posting_changed'}),revision=f.store.revision();
 for(const resumeId of ['missing','mega-source','',null,{id:'source'}]){
  const response=await f.request('/api/action',{body:{action:'selectResume',jobId:'job',resumeId}});assert.equal(response.status,400);assert.deepEqual(f.store.get('job','job'),job);assert.deepEqual(f.store.get('decision',decision.id),decision);assert.equal(f.store.revision(),revision);
 }
 assert.equal(f.store.list('postingObservation').length,0);assert.equal(f.store.list('run').length,0);
});

test('source pagination survives database restart with tied timestamps, interleaved jobs and a later observation',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-posting-restart-'));let store=new Store(directory);t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 store.put('job',{id:'job/with ? and %',identity:'identity:synthetic',state:'imported',revision:0});store.put('job',{id:'other',identity:'identity:other',state:'imported',revision:0});
 let service=new PostingObservations({store});for(const version of ['A','B','C','D']){service.record(store.get('job','job/with ? and %'),posting(version),{adopt:true});service.record(store.get('job','other'),posting(version),{adopt:true});}
 const page=service.page('job/with ? and %',{limit:2});assert.deepEqual(page.observations.map(item=>item.sourceHash),['posting-D','posting-C']);store.close();store=new Store(directory);service=new PostingObservations({store});
 service.record(store.get('job','job/with ? and %'),posting('E'),{adopt:true});const older=service.page('job/with ? and %',{limit:2,before:page.nextCursor});assert.deepEqual(older.observations.map(item=>item.sourceHash),['posting-B','posting-A']);assert.equal(older.hasMore,false);assert.equal(new Set([...page.observations,...older.observations].map(item=>item.id)).size,4);
 const cursor=JSON.parse(Buffer.from(page.nextCursor,'base64url'));cursor.sequence++;assert.throws(()=>service.page('job/with ? and %',{before:Buffer.from(JSON.stringify(cursor)).toString('base64url')}),error=>error.status===400);
 const plan=store.db.prepare("EXPLAIN QUERY PLAN SELECT rowid AS sequence,id,body FROM documents WHERE kind='postingObservation' AND json_extract(body,'$.jobId')=? AND json_extract(body,'$.jobIdentity')=? AND rowid<? ORDER BY rowid DESC LIMIT ?").all('job/with ? and %','identity:synthetic',100000,3);assert(plan.some(row=>row.detail.includes('posting_observations_by_job')));assert(!plan.some(row=>row.detail.includes('TEMP B-TREE')));
});


test('new retained snapshots project adapter fields and public URLs while preserving exact inert evidence text',async t=>{
 const f=await fixture(t),sourceUrl='https://job-boards.eu.greenhouse.io/synthetic?gh_jid=12345&access_token=synthetic-private-token&opaque=synthetic-private-query#synthetic-private-fragment',text='Literal posting text: token=synthetic-text-example stays as observed.';
 const source=posting('safe',{sourceUrl,text,cookie:'synthetic-private-cookie',request:{authorization:'synthetic-private-authorization'},requirements:['Python preferred',{authorization:'synthetic-private-requirement'}],deadline:'2027-01-01T00:00:00Z',deadlineUncertain:false,deadlineEvidence:[{source:'jsonld',quote:'2027-01-01T00:00:00Z',sourceUrl,authorization:'synthetic-private-evidence'}],documents:[{label:'Resume',name:'resume',accept:'.pdf',required:true,multiple:false,visible:true,page:'posting',coverage:'observed-native-controls',sourceUrl,cookie:'synthetic-private-document'}]});
 const observed=f.engine.postings.record(f.job,source,{adopt:true}),safe='https://job-boards.eu.greenhouse.io/synthetic?gh_jid=12345';assert.equal(observed.posting.sourceUrl,safe);assert.equal(observed.posting.documents[0].sourceUrl,safe);assert.equal(observed.posting.deadlineEvidence[0].sourceUrl,safe);assert.equal(observed.posting.text,text);assert.equal(observed.sourceHash,source.sourceHash);assert.equal(observed.urlCoverage,'sanitized_public_route');assert.equal(observed.projectionVersion,1);assert.deepEqual(observed.posting.requirements,['Python preferred']);assert.equal(observed.posting.deadline,source.deadline);assert.equal(observed.posting.documents[0].required,true);assert(!JSON.stringify(observed).includes('synthetic-private'));assert.equal(observed.contentHash.length,64);
 const unchanged=f.engine.postings.record(f.store.get('job','job'),{...source,sourceUrl:sourceUrl.replace('synthetic-private-token','replacement-private-token'),cookie:'changed-private-cookie'});assert.deepEqual(unchanged,observed);
 const sameSafe=f.engine.postings.record(f.store.get('job','job'),{...source,sourceHash:'new-full-source-hash',sourceUrl:safe});assert.equal(sameSafe.contentHash,observed.contentHash);assert.notEqual(sameSafe.id,observed.id);
 const observation=f.engine.postings.record(f.store.get('job','job'),source,{adopt:true});assert.equal(observation.sourceHash,source.sourceHash);assert.equal(observation.posting.text,text);assert.deepEqual(observation.posting.requirements,['Python preferred']);assert.equal(observation.projectionVersion,1);assert.equal(observation.urlCoverage,'sanitized_public_route');
 for(const value of [observation.posting,...observation.posting.documents,...observation.posting.deadlineEvidence])assert.equal(value.sourceUrl,'https://job-boards.eu.greenhouse.io/synthetic?gh_jid=12345');
 assert(!JSON.stringify(observation).includes('synthetic-private'));assert.equal(Object.hasOwn(observation.posting,'cookie'),false);assert.equal(Object.hasOwn(observation.posting.documents[0],'metadata'),false);
 const equivalent=f.engine.postings.record(f.store.get('job','job'),{...source,sourceHash:'safe-second-hash',sourceUrl:sourceUrl.replace('synthetic-private-token','different-private-token')},{adopt:true});assert.equal(equivalent.contentHash,observation.contentHash);assert.notEqual(equivalent.id,observation.id);
});

test('invalid retained source URLs fail before persistence at each allowed URL field',async t=>{
 const f=await fixture(t),original=f.store.get('job','job'),revision=f.store.revision();
 for(const invalid of ['https://user:synthetic-password@jobs.lever.co/synthetic/role','file:///synthetic/private','javascript:alert(1)','not a url','https://job-boards.greenhouse.io/synthetic?gh_jid=not-a-public-numeric-id'])for(const field of ['sourceUrl','documents','deadlineEvidence']){
  const source=posting('invalid');if(field==='sourceUrl')source.sourceUrl=invalid;else source[field]=[{sourceUrl:invalid,label:'Resume',source:'posting_text',quote:'Apply by June'}];
  assert.throws(()=>f.engine.postings.record(original,source,{adopt:true}),error=>error.code==='posting_source_url');assert.equal(f.store.revision(),revision);assert.deepEqual(f.store.get('job','job'),original);assert.equal(f.store.list('postingObservation').length,0);
 } const expanded=posting('expanded-url',{sourceUrl:'https://jobs.lever.co/synthetic/'+ 'é'.repeat(90000)});assert.throws(()=>f.engine.postings.record(original,expanded,{adopt:true}),error=>error.code==='posting_source_limit');assert.equal(f.store.revision(),revision);
});


test('unchanged adapter hash retains changed observed identity and availability without duplicating equivalent metadata',async t=>{
 const f=await fixture(t),service=f.engine.postings,first=service.record(f.job,posting(),{adopt:true}),original=JSON.stringify(first),ids=new Set([first.id]);
 for(const change of [{employer:'Different Synthetic Labs'},{title:'Different engineering internship'},{open:false},{expired:true}]){
  const observed=service.record(f.store.get('job','job'),posting('A',change));assert.notEqual(observed.id,first.id);ids.add(observed.id);assert.equal(observed.identityVersion,2);assert.equal(observed.sourceHash,first.sourceHash);for(const [key,value] of Object.entries(change))assert.equal(observed.posting[key],value);
  const current=service.page('job');assert.equal(current.currentObservation.id,first.id);assert.equal(current.latestObservation.id,observed.id);assert.equal(current.comparison.sourceChanged,false);assert(Object.keys(change).every(key=>current.comparison.changedFields.includes(key)));
  const repeated=service.record(f.store.get('job','job'),posting('A',{...change,text:' Version A.  Python experience is preferred. ',observedAt:'2026-11-16T15:00:00Z',documents:[{label:'Resume',page:'application',accept:'.pdf'}]}));assert.deepEqual(repeated,observed);
 }
 assert.equal(ids.size,5);assert.equal(f.store.list('postingObservation').length,5);assert.equal(JSON.stringify(f.store.get('postingObservation',first.id)),original);assert.equal(f.store.list('run').length,0);
});

test('existing hash-only posting observation is reused only for the exact observed identity and availability',async t=>{
 const f=await fixture(t),service=f.engine.postings,source=posting(),legacyId='posting-'+hash(JSON.stringify([f.job.id,f.job.identity,source.sourceHash])).slice(0,40),legacy=f.store.put('postingObservation',{id:legacyId,jobId:f.job.id,jobIdentity:f.job.identity,sourceHash:source.sourceHash,contentHash:'synthetic-existing-content-hash',posting:source,observedAt:source.observedAt});
 const pkg=f.store.put('package',{id:'legacy-bound-package',jobId:f.job.id,postingBinding:service.binding(f.job,legacy)});f.store.put('job',{...f.job,postingObservationId:legacy.id,latestPostingObservationId:legacy.id,packageId:pkg.id});
 const repeated=service.record(f.store.get('job','job'),posting('A',{observedAt:'2026-11-16T16:00:00Z',documents:[{label:'Resume',page:'application'}]}),{adopt:true});assert.deepEqual(repeated,legacy);assert.equal(f.store.get('job','job').postingObservationId,legacy.id);assert.doesNotThrow(()=>service.assertPackage(pkg));assert.equal(f.store.list('postingObservation').length,1);
 const changed=service.record(f.store.get('job','job'),posting('A',{employer:'New employer outside body text',open:false,expired:true}));assert.notEqual(changed.id,legacy.id);assert.equal(changed.posting.employer,'New employer outside body text');assert.equal(changed.posting.open,false);assert.equal(changed.posting.expired,true);assert.deepEqual(f.store.get('postingObservation',legacy.id),legacy);assert.throws(()=>service.assertPackage(pkg),error=>error.code==='posting_changed');
 const history=service.page(f.job.id);assert.equal(history.packageObservation.id,legacy.id);assert.equal(history.latestObservation.id,changed.id);assert.deepEqual(history.comparison.changedFields,['employer','expired','open']);assert.equal(f.store.list('run').length,0);
});
