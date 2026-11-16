import './runtime.mjs';
import http from 'node:http';
import { randomBytes,createHash,randomUUID,timingSafeEqual } from 'node:crypto';
import { mkdir,readFile,stat,writeFile,cp,rename,rm,chmod,lstat } from 'node:fs/promises';
import { existsSync,constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { Engine } from './engine.mjs';
import { DemoAdapter,portalFor,validateDestination } from './adapters.mjs';
import { ResumeService } from './resumes.mjs';
import { ModelService } from './model.mjs';
import { WritingService } from './writing-service.mjs';
import { SupportingDocumentService } from './supporting-documents.mjs';
import { projectWaitingDecision } from './waiting-review.mjs';
import { N8nObserver } from './n8n-observer.mjs';
import { JobDiscovery } from './job-discovery.mjs';
import { InternshipConnections } from './internship-connections.mjs';
import { LocalLaunchServer,nativeOpen } from './local-launch.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const now=()=>new Date().toISOString();
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const idFor=s=>createHash('sha256').update(s).digest('hex').slice(0,24);
export function canonicalJob(raw){
 const url=new URL(raw.trim());if(url.protocol!=='https:'||url.username||url.password||url.hash.startsWith('#token'))throw fail('Use a public HTTPS job URL without embedded credentials.');
 url.hash='';url.hostname=url.hostname.toLowerCase();if(url.port&&url.port!=='443')throw fail('Only standard HTTPS job URLs are supported.');
 for(const key of url.searchParams.keys())if(/token|password|secret|session|authorization|credential|signature/i.test(key))throw fail('Remove private access credentials from the job URL before importing.');
 for(const key of [...url.searchParams.keys()])if(/^utm_|^(source|ref|referrer|src|lever-source|gh_src)$/i.test(key))url.searchParams.delete(key);
 // Greenhouse aliases identify the same tenant/requisition; Lever /apply is the same role.
 let tenant=url.hostname,req=url.pathname.replace(/\/+$/,'');const pieces=req.split('/').filter(Boolean);
 if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(url.hostname)){const eu=url.hostname==='job-boards.eu.greenhouse.io';tenant=(eu?'greenhouse:eu:':'greenhouse:')+pieces[0];req=url.searchParams.get('gh_jid')||pieces.at(-1);url.hostname=eu?'job-boards.eu.greenhouse.io':'job-boards.greenhouse.io';}
 if(['jobs.lever.co','jobs.eu.lever.co'].includes(url.hostname)){tenant=`lever:${url.hostname==='jobs.eu.lever.co'?'eu':'us'}:${pieces[0]}`;req=pieces.filter(p=>p!=='apply').slice(1).join('/');url.pathname=url.pathname.replace(/\/apply\/?$/,'');}
 url.searchParams.sort();return {url:url.toString(),identity:`main|${tenant}|${req}|${['greenhouse:','lever:'].some(p=>tenant.startsWith(p))?'':url.searchParams.toString()}`,portal:portalFor(url.toString())};
}
function parseCSV(line){const cells=[];let value='',quoted=false;for(let i=0;i<line.length;i++){const c=line[i];if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===','&&!quoted){cells.push(value.trim());value='';}else value+=c;}if(quoted)throw fail('CSV row contains an unclosed quote.');cells.push(value.trim());return cells;}
export function importJobs(store,text){
 if(typeof text!=='string'||text.length>2*1024*1024)throw fail('Paste a URL list or CSV smaller than 2 MB.');let rows;
 try {rows=JSON.parse(text);if(!Array.isArray(rows))throw new Error();}catch{rows=text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean).filter(s=>!/^url(?:,|$)/i.test(s)).map(s=>{const [url,title,employer]=parseCSV(s);return {url,title,employer};});}
 if(rows.length>2000)throw fail('Import at most 2,000 jobs per batch.');const result={imported:0,duplicates:0,errors:[]};
 const knownIdentities=new Set();
 for(const job of store.list('job')){
  if(job.identity)knownIdentities.add(job.identity);
  // Legacy identities remain immutable. Re-derive their URL identity only for
  // import lookup so aliases cannot create a second job after an identity fix.
  try{knownIdentities.add(canonicalJob(job.url).identity);}catch{}
 }
 for(const [index,row] of rows.entries()){try{const item=typeof row==='string'?{url:row}:row;const c=canonicalJob(item.url);if(knownIdentities.has(c.identity)){result.duplicates++;continue;}store.put('job',{id:'job-'+idFor(c.identity),...c,title:String(item.title||'Posting not yet read').slice(0,250),employer:String(item.employer||'Employer not yet verified').slice(0,250),...(typeof item.discoveryCandidateId==='string'&&item.discoveryCandidateId.length<=350?{discoveryCandidateId:item.discoveryCandidateId}:{}),identityConfirmed:false,state:'imported',nextAction:'Read the actual posting and prepare',revision:0,campaignId:'main',evidence:[]});knownIdentities.add(c.identity);result.imported++;}catch(e){result.errors.push({row:index+1,message:e.message});}}
 return result;
}
function publicDocument(doc){if(!doc)return doc;const clean={};for(const [k,v] of Object.entries(doc)){if(k==='path'&&doc.type==='employer_confirmation'&&typeof v==='string'&&v.endsWith('.png'))clean.hasCapture=true;if(k==='structureContexts'||/path$|secret|password|token|credential|cookie|sessionRef/i.test(k))continue;if(k==='text'&&doc.mega){clean[k]=v;continue;}clean[k]=v&&typeof v==='object'?Array.isArray(v)?v.map(x=>x&&typeof x==='object'?publicDocument(x):x):publicDocument(v):v;}return clean;}
const kinds=['profile','campaign','job','resume','fact','package','decision','decision_attention','event','account','automation','run','connection','account_config','verification_request','verification_receipt','inbox_proposal','discovery_source','discovery_candidate','discovery_favorite','discovery_rate'];
async function readJSON(req){const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>72*1024*1024)throw fail('Request exceeds 72 MB.',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{throw fail('Invalid JSON request.');}}

export async function createHub({directory=process.env.HUB_DATA_DIR||path.join(homedir(),'Library','Application Support','Automation Hub'),port=Number(process.env.HUB_PORT||4317),host='127.0.0.1',open=false,dev=false,modelRunner=null,engineAdapter=null,inboxRunner=null,inboxCommand,oauthFetcher,n8nFetcher,n8nResolver,n8nClock,discoveryOptions={},enableControl=false,openBrowser=nativeOpen}={}){
 if(host!=='127.0.0.1')throw fail('This private hub binds to 127.0.0.1 only.');
 if(!path.isAbsolute(directory))throw fail('Use an absolute private application data directory.');await mkdir(directory,{recursive:true,mode:0o700});const storageOwner=await lstat(directory);if(!storageOwner.isDirectory()||storageOwner.isSymbolicLink()||typeof process.getuid==='function'&&storageOwner.uid!==process.getuid())throw fail('The private application directory must be an owned directory, without a symbolic link.',403);await chmod(directory,0o700);const sessions=new Map(),oauthBindings=new Map(),launchTickets=new Map();let baseUrl;let vite;let control;let phase='open',closing;const activeRequests=new Set();
 const assertAccepting=()=>{if(phase!=='open')throw fail('The hub is stopping. Reopen it from the Mac app after shutdown completes.',503);};
 const admittedJSON=async req=>{const body=await readJSON(req);assertAccepting();return body;};
 const issueLaunchUrl=()=>{assertAccepting();for(const [key,expires] of launchTickets)if(expires<Date.now())launchTickets.delete(key);const ticket=randomBytes(32).toString('hex');launchTickets.set(ticket,Date.now()+120000);return `${baseUrl}/auth?ticket=${ticket}`;};
 const contexts=new Map();
 function context(demo=false){
  assertAccepting();if(contexts.has(demo))return contexts.get(demo);
  const dir=path.join(directory,demo?'rehearsal':'live'),store=new Store(dir);
  if(demo)store.put('campaign',{...store.get('campaign','main'),mode:'demo'});
  const model=new ModelService({store,directory:dir,runner:modelRunner}),resumes=new ResumeService({store,directory:dir,model}),writing=new WritingService({store,model}),supporting=new SupportingDocumentService({store,directory:dir});
  const connections=new InternshipConnections({store,directory:dir,demo,inboxRunner,inboxCommand,oauthFetcher}),n8n=new N8nObserver({store,vault:connections.vault,fetcher:n8nFetcher,resolver:n8nResolver,clock:n8nClock});let engine;
  try{engine=new Engine({store,directory:dir,resumes,adapter:demo?new DemoAdapter():engineAdapter,demo,vault:connections.vault,accountAdapter:connections.accounts,supportingService:supporting,priorSubmissionResolver:demo?null:(job,profile)=>connections.prior(job,profile)});}catch(error){connections.close().catch(()=>{});store.close();throw error;}
  const discovery=new JobDiscovery({...discoveryOptions,store});
  const ctx={dir,store,model,resumes,writing,supporting,n8n,discovery,engine,connections,demo};contexts.set(demo,ctx);if(baseUrl){engine.start();connections.start();}return ctx;
 }
 const live=context(false);
 async function demoSeed(ctx){if(ctx.store.list('job').length)return;ctx.store.put('profile',{id:'main',fullName:'Alex Example',email:'alex@example.invalid',phone:'555-0100',location:'New York',answers:{},links:{}});const md='# Alex Example\nEngineering student\n\n## Projects\n### Sensor prototype\n- Built a simulated sensor prototype in Python to evaluate signal quality.\n- Measured 12 test cases in a controlled simulation.\n\n## Skills\nPython, JavaScript, signal processing';await ctx.resumes.import([{name:'Example resume.md',content:Buffer.from(md).toString('base64'),mega:false}]);
  importJobs(ctx.store,JSON.stringify([{url:'https://fixture.example.invalid/example/engineering-intern',title:'Engineering intern',employer:'Example Labs'},{url:'https://fixture.example.invalid/example/question-intern',title:'Question internship',employer:'Example Robotics'}]));
  // Synthetic reasoning is confined to the rehearsal store and is visibly labeled.
  ctx.model.runner=async input=>({chosenResumeId:input.resumes?.[0]?.id||'synthetic-resume',explanation:'Fixture: reuse the finished source unchanged. This is synthetic reasoning, not live hiring evaluation.',edits:[],requirements:[],questions:[]});ctx.store.put('connection',{id:'model',enabled:true,verified:true,fixture:true});ctx.store.put('campaign',{...ctx.store.get('campaign','main'),rules:{maxApplications:10,maxPerEmployer:3,allowedHosts:['fixture.example.invalid'],allowAccountCreation:false,autoApproveUnchanged:true}});
 }
 async function state(ctx){
  assertAccepting();const {store,engine,model,demo,connections}=ctx,jobs=store.list('job'),connectionState=await connections.snapshot();
  const attentionById=new Map(store.list('decision_attention').map(record=>[record.id,record]));
  const readiness=[model.readiness(),...await engine.readiness(),connectionState.inbox,{id:'dot',label:'Dot summaries',status:'missing',detail:'Dashboard summaries are available. Dot access will be granted separately.'}];
  return {demo,profile:publicDocument(store.get('profile','main')),campaign:publicDocument(store.get('campaign','main')),jobs:jobs.map(publicDocument),resumes:store.list('resume').map(publicDocument),facts:store.list('fact').map(publicDocument),packages:store.list('package').map(publicDocument),writingDrafts:store.list('writingDraft').map(publicDocument),supportingDocuments:store.list('supportingDocument').map(publicDocument),decisions:store.list('decision').map(decision=>publicDocument(projectWaitingDecision(decision,jobs,attentionById.get(decision.id)))),events:store.list('event').slice(-150).reverse().map(publicDocument),accounts:store.list('account').map(publicDocument),automations:store.list('automation').map(publicDocument),connections:store.list('connection').map(publicDocument),model:publicDocument(store.get('connection','model')),...publicDocument(connectionState),n8n:publicDocument(ctx.n8n.snapshot()),discovery:publicDocument({...ctx.discovery.snapshot({limit:0}),usInternshipsTotal:ctx.discovery.snapshot({usOnly:true,roleType:'intern',limit:0}).total}),readiness,summary:{selected:jobs.length,prepared:jobs.filter(j=>j.packageId).length,confirmed:jobs.filter(j=>j.submissionConfirmation==='employer_confirmed').length,fixtureConfirmed:jobs.filter(j=>j.submissionConfirmation==='fixture').length,needsYou:store.list('decision').filter(d=>d.state==='open').length+connectionState.inboxProposals.length+connectionState.verificationRequests.length,uncertain:jobs.filter(j=>j.state==='uncertain').length}};
 }
 async function resolveOwn(ctx,body){const {store}=ctx;const d=store.get('decision',body.decisionId);if(!d)return null;if(d.state==='resolved')return d;
  if(d.type==='fact_conflict'){const answer=String(body.answer||'');if(!answer)throw fail('Choose a source passage or keep this conflict unresolved.');const chosen=store.list('fact').find(f=>d.factIds.includes(f.id)&&f.text===answer);store.transaction(()=>{for(const id of d.factIds){const f=store.get('fact',id);if(f&&chosen)store.put('fact',{...f,conflict:false,suppressed:id!==chosen.id,confirmedAt:now()});}store.put('decision',{...d,state:chosen?'resolved':'open',answer,resolvedAt:chosen?now():null});});return {resolved:Boolean(chosen)};}
  if(d.type==='missing_fact'){const job=store.get('job',d.jobId);if(!job)throw fail('Application not found.',404);if(body.answer===undefined||body.answer==='')throw fail('Provide an answer or choose none.');store.put('decision',{...d,state:'resolved',answer:body.answer,resolvedAt:now()});const remaining=store.list('decision').some(x=>x.jobId===job.id&&x.type==='missing_fact'&&x.state==='open');store.put('job',{...job,reasoningAnswers:{...job.reasoningAnswers,[d.question]:body.answer},state:job.state==='manual'?'manual':remaining?'needs_you':'imported',preparationRequested:job.state==='manual'?false:!remaining,revision:job.revision+1,nextAction:job.state==='manual'?'Your answer is saved; reconcile manual work before resuming':remaining?'Answer remaining questions':'Resume with your scoped answers'});return {resolved:true};}return null;
 }
 async function action(ctx,body,metadata={}){assertAccepting();const {store,engine,resumes,model,connections,writing,supporting}=ctx;
  if(body.action==='discoveryRegisterSource')return publicDocument(ctx.discovery.registerSource(body));
  if(body.action==='discoveryRefresh')return publicDocument(await ctx.discovery.refresh(body.sourceId));
  if(body.action==='discoveryFavorite')return publicDocument(ctx.discovery.setFavorite(body.candidateId,body.favorite));
  if(body.action==='discoveryRemoveSource')return publicDocument(ctx.discovery.removeSource(body.sourceId));
  if(body.action==='discoveryQueue'){
   const candidate=ctx.discovery.candidateForQueue(body.candidateId),identity=canonicalJob(candidate.url).identity;
   const result=importJobs(store,JSON.stringify([candidate]));
   const job=store.list('job').find(job=>{try{return job.identity===identity||canonicalJob(job.url).identity===identity;}catch{return false;}});
   if(!job||result.errors.length)throw fail('This role could not be added to applications. Its discovery record was preserved.',409);
   return {...result,queued:true,jobId:job.id};
  }
  if(connections.hasAction(body.action)){try{return publicDocument(await connections.action(body.action,body,metadata));}catch(error){if(error.hold&&!error.status)error.status=409;throw error;}}
  if(body.action==='draftWriting'||body.action==='attachSupportingDocument'){
   if(!body.expectedBinding||typeof body.expectedBinding!=='object'||Array.isArray(body.expectedBinding))throw fail('Review the current question and candidate context before this action.',400);
   return publicDocument(body.action==='draftWriting'?await writing.draft(body):await supporting.attach(body));
  }
  if(body.action==='configureN8nObserver'||body.action==='observeWorkflow'){if(ctx.demo)throw fail('Configure real n8n observations in the real workspace.',409);return publicDocument(body.action==='configureN8nObserver'?await ctx.n8n.configure(body):await ctx.n8n.observe(body.automationId));}
  if(body.action==='saveProfile'){const p=body.profile;if(!p||typeof p!=='object')throw fail('Profile is required.');const allowed=['fullName','email','phone','location','availability','preferences','links','answers','writingApprovals'];const safe={};for(const key of allowed)if(p[key]!==undefined)safe[key]=p[key];if(JSON.stringify(safe).length>100000)throw fail('Profile is too large.');const saved=store.put('profile',{...store.get('profile','main'),...safe,id:'main'});const campaign=store.get('campaign','main');if(campaign.enabled)store.put('campaign',{...campaign,enabled:false,status:'draft',revision:campaign.revision+1});return publicDocument(saved);}
  if(body.action==='modelSettings'){store.put('connection',{...store.get('connection','model'),id:'model',enabled:body.enabled===true});return model.readiness();}
  if(body.action==='probeModel')return model.probe();
  if(body.action==='resolveDecision'){const result=await resolveOwn(ctx,body);if(result)return result;}
  if(body.action==='selectResume'){
   const job=store.get('job',body.jobId);if(!job)throw fail('Application not found.',404);
   if(['preparing','applying','uncertain','submitted','manual','interview','offer','rejected','assessment','cancelled','closed'].includes(job.state))throw fail('This application cannot change documents in its current state.',409);
   if(!job.posting?.sourceHash){store.put('job',{...job,selectedResumeId:body.resumeId,state:'imported',preparationRequested:true,revision:job.revision+1,nextAction:'Read actual posting before preparing your selected resume'});return {queued:true};}
   const fenced=store.put('job',{...job,state:'preparing',revision:job.revision+1,preparationRequested:false,nextAction:'Prepare your selected finished resume'});
   try{const pkg=await resumes.select(fenced,body.resumeId);const latest=store.get('job',job.id);
    if(latest.revision!==fenced.revision||latest.state!=='preparing')throw fail('This application changed during preparation. Open its current state before selecting a resume.',409);
    const prepared=store.put('job',{...latest,packageId:pkg.id}),requirements=engine.reviewRequirements(prepared,pkg),limits=engine.reviewApplicationLimits(store.get('job',job.id)),current=store.get('job',job.id);
    const open=store.list('decision').find(d=>d.jobId===job.id&&d.state==='open'&&d.code!=='package_review'),waiting=requirements.unresolvedMandatory.length>0||!limits.allowed||Boolean(open);
    store.put('job',{...current,packageId:pkg.id,state:waiting?'needs_you':'ready',revision:current.revision+1,nextAction:waiting?(!limits.allowed?limits.nextAction:open?.message||open?.question||'Resolve the remaining saved decisions'):'Review final resume before submission'});return publicDocument(pkg);
   }catch(error){const latest=store.get('job',job.id);if(latest.revision===fenced.revision&&latest.state==='preparing')store.put('job',{...latest,state:job.state,revision:latest.revision+1,nextAction:'Resume selection did not finish. Check the source and try again.'});throw error;}
  }
  if(body.action==='reviewPackage'){const pkg=store.get('package',body.packageId);if(!pkg?.verified)throw fail('No verified resume package is available.',404);if(body.approved===true)try{resumes.assertPackageCurrent?.(pkg);}catch(error){if(error.code==='resume_review')throw fail(error.message,409);throw error;}const job=store.get('job',pkg.jobId);if(!job||job.packageId!==pkg.id||['applying','uncertain','submitted','manual'].includes(job.state))throw fail('This package is no longer awaiting review.',409);const saved=store.put('package',{...pkg,approved:body.approved===true,approvedAt:body.approved?now():null});for(const d of store.list('decision'))if(d.jobId===job.id&&d.code==='package_review'&&d.state==='open')store.put('decision',{...d,state:'resolved',answer:body.approved?'approve':'decline',resolvedAt:now()});const waiting=store.list('decision').some(d=>d.jobId===job.id&&d.state==='open');store.put('job',{...job,state:body.approved&&!waiting?'ready':'needs_you',revision:job.revision+1,nextAction:body.approved?'Ready for enabled campaign':'Choose or prepare another resume'});return publicDocument(saved);}
  if(body.action==='registerWorkflow'){
   const name=typeof body.name==='string'?body.name.trim():'';if(!name||name.length>120)throw fail('Use a workflow name from 1 to 120 characters.');
   const canonical=raw=>{let url;try{url=new URL(raw);}catch{throw fail('Use the existing n8n workflow page URL.');}if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw fail('Provide a supported workflow URL without credentials.');if(url.pathname.length>500||!/^\/(?:[A-Za-z0-9_-]+\/)*workflow\/[A-Za-z0-9_-]{1,128}\/?$/.test(url.pathname))throw fail('Use the existing n8n workflow page URL with a supported workflow ID.');if(url.search||url.hash)throw fail('Remove query parameters and fragments from the workflow link.');url.pathname=url.pathname.replace(/\/$/,'');return url;};
   const url=canonical(body.url),identity=url.toString();const prior=store.list('automation').find(a=>{if(a.executor!=='n8n')return false;try{return canonical(a.externalUrl).toString()===identity;}catch{return false;}});if(prior)return prior;return store.put('automation',{id:'external-'+idFor(identity),name,purpose:'Existing n8n workflow',version:1,executor:'n8n',scheduleOwner:'n8n',mode:'observe_only',externalUrl:identity,workflowId:url.pathname.split('/').filter(Boolean).at(-1),state:'unknown',lastObservedAt:null,detail:'Linked for navigation. Runtime status is unknown until a supported authenticated n8n API connection is configured. Existing schedules remain owned by n8n.'});
  }
  if(body.action==='backup'){
   if(engine.busy)throw fail('Wait for the current step to finish before making a consistent backup.',409);const backupRoot=path.join(directory,'backups');await mkdir(backupRoot,{recursive:true,mode:0o700});const name=`${ctx.demo?'rehearsal':'live'}-${now().replace(/[:.]/g,'-')}`,dest=path.join(backupRoot,name),partial=dest+'.partial';await mkdir(partial,{mode:0o700});engine.busy=true;try{await store.backup(path.join(partial,'hub.sqlite'));await connections.vault.pending;for(const item of ['resumes','packages','supporting-documents','evidence','app-vault.json'])if(existsSync(path.join(ctx.dir,item)))await cp(path.join(ctx.dir,item),path.join(partial,item),{recursive:true});const manifest={version:1,createdAt:now(),mode:ctx.demo?'demo':'live',originalDirectory:ctx.dir,files:['hub.sqlite','resumes','packages','supporting-documents','evidence','app-vault.json'],providerAuth:'Not included. Reconnect the dedicated native provider if needed.',restore:'Stop hub, preserve live folder, restore backup to originalDirectory. See recovery instructions.'};await writeFile(path.join(partial,'manifest.json'),JSON.stringify(manifest,null,2),{mode:0o600});await rename(partial,dest);}catch(e){await rm(partial,{recursive:true,force:true});throw e;}finally{engine.busy=false;}return {created:true,name,message:'Private local backup created with database, originals, final documents and evidence.'};
  }
  return publicDocument(await engine.action(body.action,body));
 }
 const handleRequest=async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','SAMEORIGIN');
  res.setHeader('Content-Security-Policy',dev?"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'":"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src 'self'; worker-src 'self' blob:; object-src 'none'");
  const send=(data,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  try{
   assertAccepting();if(req.headers.host!==new URL(baseUrl).host)throw fail('Invalid local host.',403);const url=new URL(req.url,baseUrl);
   if(url.pathname==='/auth'){
    const candidateTicket=url.searchParams.get('ticket');if(req.method!=='GET'||!candidateTicket||!launchTickets.has(candidateTicket)||launchTickets.get(candidateTicket)<Date.now())throw fail('The launch ticket is invalid or expired. Reopen the hub from its local launcher.',401);
    launchTickets.delete(candidateTicket);const session=randomBytes(32).toString('hex');sessions.set(session,{demo:false,expires:Date.now()+12*3600*1000});res.setHeader('Set-Cookie',`hub_session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);res.writeHead(303,{Location:'/'});res.end();return;
   }
   if(url.pathname==='/oauth/gmail/callback'){
    if(req.method!=='GET')throw fail('The Google callback requires a supported browser return.',405);
    const binding=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('hub_oauth_binding='))?.slice('hub_oauth_binding='.length),pending=oauthBindings.get(binding),owner=pending&&sessions.get(pending.sessionKey);
    res.setHeader('Set-Cookie','hub_oauth_binding=; HttpOnly; SameSite=Lax; Path=/oauth/gmail; Max-Age=0');
    if(!pending||pending.expires<Date.now()||!owner||owner.expires<Date.now()||pending.demo)throw fail('This Google return does not belong to an active local authorization. Start again in Connections.',401);
    oauthBindings.delete(binding);const ctx=context(false);
    try{await ctx.connections.gmailOAuth.complete({state:url.searchParams.get('state'),code:url.searchParams.get('code'),error:url.searchParams.get('error'),baseUrl,sessionId:binding});res.writeHead(303,{Location:'/'});res.end();}
    catch(error){const message=String(error.status?error.message:'Google authorization did not finish. Return to Connections and try again.').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));res.writeHead(error.status||409,{'Content-Type':'text/html; charset=utf-8'});res.end(`<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Gmail connection</title><body><main><h1>Gmail connection</h1><p>${message}</p><a href="/">Return to the automation hub</a></main></body></html>`);}return;
   }
   const sessionKey=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('hub_session='))?.slice(12),session=sessions.get(sessionKey);
   if(url.pathname.startsWith('/api/')&&(!session||session.expires<Date.now()))throw fail('This local session expired. Reopen the hub with its local launcher.',401);
   const workspace=session?{demo:session.demo,revision:session.workspaceRevision||0}:null;
   const assertWorkspace=()=>{if(!session||session.demo!==workspace.demo||(session.workspaceRevision||0)!==workspace.revision)throw Object.assign(fail('The current workspace changed while this request was arriving. Refresh before making changes.',409),{code:'WORKSPACE_CHANGED'});};
   const workspaceJSON=async()=>{const body=await admittedJSON(req);assertWorkspace();return body;};
   if(url.pathname.startsWith('/api/')&&req.method!=='GET'&&req.headers.origin!==baseUrl)throw fail('This action must come from the local hub.',403);
   if(req.method==='POST'&&!String(req.headers['content-type']).startsWith('application/json'))throw fail('Use a JSON request.',415);
   if(url.pathname.startsWith('/api/')&&req.method==='POST'&&req.headers['x-hub-workspace']!==undefined){const expected=req.headers['x-hub-workspace'];if(!['real','fixture'].includes(expected))throw fail('The workspace binding is invalid.',400);if((expected==='fixture')!==session.demo)throw Object.assign(fail('The current workspace changed in another window. Refresh before making changes.',409),{code:'WORKSPACE_CHANGED'});}
   if(url.pathname==='/api/state'&&req.method==='GET'){const ctx=context(workspace.demo),vault=await ctx.connections.vault.status();assertWorkspace();const etag='\"'+(ctx.demo?'demo':'live')+'-'+ctx.store.revision()+'-'+Number(vault.unlocked)+'-'+Number(vault.configured)+'-'+idFor(JSON.stringify({n8n:ctx.n8n.snapshot(),verification:ctx.connections.activeVerificationRequests(),discovery:ctx.discovery.snapshot({limit:0})}))+'\"';res.setHeader('ETag',etag);if(req.headers['if-none-match']===etag){res.writeHead(304);res.end();return;}const value=await state(ctx);assertWorkspace();send(value);return;}
   if(url.pathname==='/api/discovery'&&req.method==='GET'){
    const allowed=new Set(['query','provider','sourceId','favoriteOnly','usOnly','availability','locationScope','location','workplace','roleType','discipline','sort','limit','offset']),filters={};
    for(const [key,value] of url.searchParams){if(!allowed.has(key)||url.searchParams.getAll(key).length!==1)throw fail('Use supported discovery filters once each.');if(['favoriteOnly','usOnly'].includes(key)){if(!['true','false'].includes(value))throw fail('Use true or false for saved and US location filters.');filters[key]=value==='true';}else if(['limit','offset'].includes(key)){if(!/^\d{1,6}$/.test(value))throw fail('Use a bounded discovery page.');filters[key]=Number(value);}else filters[key]=value;}
    const value=context(workspace.demo).discovery.snapshot(filters);assertWorkspace();send(publicDocument(value));return;
   }
   if(url.pathname==='/api/demo'&&req.method==='POST'){const body=await workspaceJSON();if(typeof body.enabled!=='boolean')throw fail('Choose either the real or fixture workspace.',400);const ctx=context(body.enabled);if(body.enabled)await demoSeed(ctx);assertWorkspace();session.demo=body.enabled;const committedRevision=session.workspaceRevision=workspace.revision+1;const value=await state(ctx);if(session.demo!==body.enabled||session.workspaceRevision!==committedRevision)throw Object.assign(fail('The workspace changed again before this switch could be confirmed. Refresh before making changes.',409),{code:'WORKSPACE_CHANGED'});send(value);return;}
   if(url.pathname==='/api/import/resumes'&&req.method==='POST'){const body=await workspaceJSON();send(await context(workspace.demo).resumes.import(body.files));return;}
   if(url.pathname==='/api/import/jobs'&&req.method==='POST'){const body=await workspaceJSON();send(importJobs(context(workspace.demo).store,body.text));return;}
   if(url.pathname==='/api/action'&&req.method==='POST'){
    const body=await workspaceJSON(),ctx=context(workspace.demo);
    if(body.action==='beginGmailAuthorization'){
     if(session.demo)throw fail('Real Gmail authorization is unavailable in the fixture workspace.',409);
     for(const [key,value] of oauthBindings)if(value.expires<Date.now()||value.sessionKey===sessionKey)oauthBindings.delete(key);
     const binding=randomBytes(32).toString('base64url'),result=await action(ctx,body,{baseUrl,sessionId:binding});oauthBindings.set(binding,{sessionKey,demo:false,expires:Date.now()+10*60000});
     res.setHeader('Set-Cookie',`hub_oauth_binding=${binding}; HttpOnly; SameSite=Lax; Path=/oauth/gmail; Max-Age=600`);send(result);return;
    }
    send(await action(ctx,body,{baseUrl}));return;
   }
   if(url.pathname==='/api/export'&&req.method==='GET'){const ctx=context(session.demo),result={version:1,mode:session.demo?'demo':'live',exportedAt:now()};for(const kind of kinds)result[kind]=ctx.store.list(kind).map(publicDocument);res.setHeader('Content-Disposition','attachment; filename="automation-hub-export.json"');send(result);return;}
   if(url.pathname.startsWith('/api/evidence/')&&req.method==='GET'){
    const id=decodeURIComponent(url.pathname.slice('/api/evidence/'.length)),ctx=context(session.demo);if(!/^[A-Za-z0-9_-]{1,200}$/.test(id))throw fail('Receipt capture not found.',404);const evidence=ctx.store.list('job').flatMap(j=>j.evidence||[]).find(e=>e.id===id);const file=evidence?.type==='employer_confirmation'?evidence.path:null;if(!file||!file.endsWith('.png')||!path.resolve(file).startsWith(path.join(ctx.dir,'evidence')+path.sep))throw fail('Receipt capture not found.',404);const bytes=await readFile(file,{flag:constants.O_RDONLY|constants.O_NOFOLLOW});res.setHeader('Content-Type','image/png');res.end(bytes);return;
   }
   if(url.pathname.startsWith('/api/files/')&&req.method==='GET'){
    const id=decodeURIComponent(url.pathname.slice('/api/files/'.length));const ctx=context(session.demo);const doc=ctx.store.get('resume',id)||ctx.store.get('package',id)||ctx.store.get('supportingDocument',id);if(!doc)throw fail('Document not found.',404);if(doc.renderVerification&&doc.binding)await ctx.supporting.verifyStored(doc);const original=url.searchParams.get('variant')==='original';const file=original?(doc.originalPath||doc.finalPath):(doc.previewPath||doc.finalPath||doc.originalPath);if(!file||!path.resolve(file).startsWith(ctx.dir+path.sep))throw fail('Document preview unavailable.',404);const bytes=await readFile(file);res.setHeader('Content-Type',file.endsWith('.pdf')?'application/pdf':file.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'text/plain; charset=utf-8');res.setHeader('Content-Disposition',`${url.searchParams.has('download')?'attachment':'inline'}; filename="${doc.id}${path.extname(file)}"`);res.end(bytes);return;
   }
   if(req.method!=='GET')throw fail('Route not found.',404);
   if(dev){vite.middlewares(req,res,()=>{res.writeHead(404);res.end('Not found');});return;}
   const requested=url.pathname==='/'?'/index.html':url.pathname;const file=path.resolve(root,'dist','.'+requested);if(!file.startsWith(path.join(root,'dist')+path.sep))throw fail('Not found.',404);let data;try{data=await readFile(file);}catch{if(!path.extname(requested))data=await readFile(path.join(root,'dist','index.html'));else throw fail('Build the UI with npm run build before launching.',404);}const ext=path.extname(requested);res.setHeader('Content-Type',({'.js':'text/javascript','.mjs':'text/javascript','.txt':'text/plain','.wasm':'application/wasm','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.html':'text/html'}[ext]||'text/html')+'; charset=utf-8');res.end(data);
  }catch(error){if(!res.destroyed&&!res.writableEnded)send({error:error.status?error.message:'The operation could not finish. Check the input and connection, then retry.',code:error.code||null},error.status||400);}
 };
 const server=http.createServer((req,res)=>{let pending;pending=handleRequest(req,res).catch(()=>{if(!res.destroyed&&!res.writableEnded)res.destroy();}).finally(()=>activeRequests.delete(pending));activeRequests.add(pending);});
 if(dev){const {createServer}=await import('vite');vite=await createServer({server:{middlewareMode:true},appType:'spa'});}
 try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});}catch(error){for(const ctx of contexts.values()){ctx.discovery.close();await ctx.engine.stop();await ctx.connections.close();ctx.store.close();}if(vite)await vite.close();throw error;}baseUrl=`http://${host}:${server.address().port}`;
 if(enableControl){try{control=new LocalLaunchServer({directory,issueLaunchUrl});await control.start({leaseAcquired:true});}catch(error){for(const ctx of contexts.values()){ctx.discovery.close();await ctx.engine.stop();await ctx.connections.close();ctx.store.close();}await new Promise(resolve=>server.close(resolve));if(vite)await vite.close();throw error;}}
 for(const ctx of contexts.values()){ctx.engine.start();ctx.connections.start();}
 const launchUrl=issueLaunchUrl();
 const close=()=>{
  if(closing)return closing;phase='closing';closing=(async()=>{const owned=[...contexts.values()],tasks=[];
   // Revoke side effects first, but retain each worker lease until ALL admitted API work drains.
   for(const ctx of owned){ctx.writing.close();ctx.supporting.close();ctx.n8n.close();ctx.discovery.close();tasks.push(ctx.engine.stop({releaseWorker:false}),ctx.model.close(),ctx.connections.close());}
   tasks.push(Promise.resolve().then(()=>control?.close()));
   tasks.push(new Promise(resolve=>{const timer=setTimeout(()=>server.closeAllConnections(),5000);timer.unref?.();server.close(()=>{clearTimeout(timer);resolve();});server.closeIdleConnections?.();}));
   if(vite)tasks.push(vite.close());
   // Requests accepted before phase changed may finish their authorized local imports;
   // post-body/action checks reject anything that had not yet been admitted.
   tasks.push(...activeRequests);const results=await Promise.allSettled(tasks);let failure=results.find(result=>result.status==='rejected')?.reason;
   for(const ctx of owned){try{ctx.engine.releaseWorker();ctx.store.close();}catch(error){failure ||= error;}}
   sessions.clear();oauthBindings.clear();launchTickets.clear();phase='closed';if(failure)throw failure;
  })();return closing;
 };
 if(open)try{await openBrowser(launchUrl);}catch(error){await close();throw error;}
 return {server,baseUrl,launchUrl,context,state,close};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const hub=await createHub({open:!process.argv.includes('--no-open'),dev:process.argv.includes('--dev'),enableControl:true});console.log(`Automation hub is running at ${hub.baseUrl}. A private local session opens in your browser. Data stays in its separate Application Support folder. Press Ctrl+C to stop.`);
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await hub.close();process.exit(0);});
}
