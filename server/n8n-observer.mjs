import {createHash,randomBytes} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import http from 'node:http';
import https from 'node:https';
import {privateAddress} from './adapters.mjs';
const META='n8n',SCOPES=['workflow:read','execution:list'],LIMIT=2*1024*1024;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fault=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const idPattern=/^[A-Za-z0-9_-]{1,128}$/;
const statuses=new Set(['new','running','success','error','canceled','crashed','waiting','unknown','queued']);
function base(raw,allowLocal){
 if(typeof raw!=='string'||raw.length>1000)throw fault('N8N_URL','Use the exact n8n instance URL, without API routes, credentials or query values.',400);
 let url;try{url=new URL(raw);}catch{throw fault('N8N_URL','The n8n instance URL is invalid.',400);}
 if(url.username||url.password||url.search||url.hash||!/^(?:\/[A-Za-z0-9_-]+)*\/?$/.test(url.pathname)||/\/(?:api\/v\d+|workflow\/[^/]+)\/?$/.test(url.pathname))throw fault('N8N_URL','Use the instance base URL without API routes, workflow pages, credentials or query values.',400);
 const local=['127.0.0.1','localhost'].includes(url.hostname);
 if(local){if(allowLocal!==true||url.protocol!=='http:'||!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/|$)/i.test(raw))throw fault('N8N_DESTINATION','Local observation requires explicit permission for HTTP localhost or 127.0.0.1.',400);}
 else if(url.protocol!=='https:'||url.port&&url.port!=='443'||url.hostname==='metadata.google.internal'||url.hostname.endsWith('.localhost')||url.hostname.endsWith('.local')||isIP(url.hostname.replace(/^\[|\]$/g,''))&&privateAddress(url.hostname))throw fault('N8N_DESTINATION','Only a public HTTPS instance or explicitly selected local HTTP instance is supported.',400);
 const basePath=url.pathname.replace(/\/$/,'');return {baseUrl:url.origin+basePath,origin:url.origin,basePath,allowLocal:local&&allowLocal===true,hostname:url.hostname.replace(/^\[|\]$/g,'')};
}
const binding=config=>({tenant:config.baseUrl,candidateId:'main',purpose:'n8n-readonly'});
function automationFor(automation,config){
 if(!automation||automation.executor!=='n8n'||!idPattern.test(automation.workflowId||''))throw fault('N8N_AUTOMATION','Choose a registered existing n8n workflow.');
 let url;try{url=new URL(automation.externalUrl);}catch{throw fault('N8N_AUTOMATION','The existing workflow link is invalid.');}
 const expected=config.basePath+'/workflow/'+automation.workflowId;
 if(url.username||url.password||url.search||url.hash||url.origin!==config.origin||url.pathname.replace(/\/$/,'')!==expected)throw fault('N8N_INSTANCE','This workflow does not belong to the exact configured n8n instance and base path.');
 return automation;
}
function timestamp(value){if(value===undefined||value===null)return null;if(typeof value!=='string'||value.length>50||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))throw fault('N8N_RESPONSE','n8n returned invalid execution timestamps.');return new Date(value).toISOString();}
function metadata(workflow,executions,workflowId,key){
 if(!workflow||workflow.id!==workflowId||typeof workflow.name!=='string'||typeof workflow.active!=='boolean'||workflow.isArchived!==undefined&&typeof workflow.isArchived!=='boolean')throw fault('N8N_IDENTITY','The n8n response does not prove this exact workflow identity and state.');
 if(workflow.name.includes(key))throw fault('N8N_RESPONSE','n8n returned credential material in metadata. No new observation was saved.');
 if(!executions||!Array.isArray(executions.data)||executions.data.length>5||executions.nextCursor!==undefined&&executions.nextCursor!==null&&typeof executions.nextCursor!=='string')throw fault('N8N_RESPONSE','n8n did not return the bounded execution metadata list.');
 const rows=executions.data.map(row=>{if(!row||!idPattern.test(row.id||'')||row.workflowId!==workflowId||typeof row.status!=='string')throw fault('N8N_IDENTITY','An execution does not match the selected workflow.');return {id:row.id,workflowId,status:statuses.has(row.status)?row.status:'unknown',startedAt:timestamp(row.startedAt),stoppedAt:timestamp(row.stoppedAt),waitTill:timestamp(row.waitTill)};});
 const result={workflow:{id:workflowId,name:workflow.name.replace(/[\x00-\x1f]/g,' ').slice(0,250),active:workflow.active,isArchived:workflow.isArchived??null},executions:rows,historyHasMore:Boolean(executions.nextCursor),historyCoverage:'visible_non_running_executions',metadataOnly:true};
 const reflects=value=>typeof value==='string'?value.includes(key):value!==null&&typeof value==='object'?Object.values(value).some(reflects):false;
 if(reflects(result))throw fault('N8N_RESPONSE','n8n returned credential material in metadata. No new observation was saved.');return result;
}
// Native requests ignore proxy environment variables. DNS is resolved and
// checked first, then pinned into this connection; TLS still verifies the
// original configured hostname. No redirect or caller-controlled method exists.
function nativeFetcher(raw,{headers,signal,lookup:connectionLookup}){
 return new Promise((resolve,reject)=>{
  const url=new URL(raw),transport=url.protocol==='https:'?https:http;
  const request=transport.request(url,{method:'GET',headers,signal,lookup:connectionLookup,agent:false,rejectUnauthorized:true,autoSelectFamily:false},response=>resolve({status:response.statusCode,headers:response.headers,body:response,url:raw,redirected:false}));
  request.once('error',()=>reject(fault('N8N_UNAVAILABLE','The configured n8n instance could not be reached securely.')));request.end();
 });
}
async function boundedJSON(response){
 const length=Number(response.headers?.get?.('content-length')??response.headers?.['content-length']);if(Number.isFinite(length)&&length>LIMIT){response.body?.destroy?.();throw fault('N8N_RESPONSE_LIMIT','The n8n metadata response exceeded its read limit.');}
 const chunks=[];let bytes=0;if(!response.body||typeof response.body[Symbol.asyncIterator]!=='function')throw fault('N8N_RESPONSE','n8n returned no readable metadata body.');
 try{for await(const chunk of response.body){const value=typeof chunk==='string'?Buffer.from(chunk):Buffer.from(chunk);bytes+=value.length;if(bytes>LIMIT){response.body.destroy?.();throw fault('N8N_RESPONSE_LIMIT','The n8n metadata response exceeded its read limit.');}chunks.push(value);}return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}catch(error){if(error.code==='N8N_RESPONSE_LIMIT')throw error;throw fault('N8N_RESPONSE','n8n returned unreadable metadata.');}
}
export class N8nObserver{
 constructor({store,vault,fetcher=nativeFetcher,resolver=lookup,clock=Date.now,timeoutMs=5000,minIntervalMs=10000,staleMs=5*60000}={}){Object.assign(this,{store,vault,fetcher,resolver,clock,timeoutMs:Math.min(15000,Math.max(20,timeoutMs)),minIntervalMs:Math.max(1,minIntervalMs),staleMs,epoch:0,closed:false,busy:false,configuring:false});this.controllers=new Set();}
 meta(){return this.store.get('connection',META);}
 status(){const config=this.meta(),configured=Boolean(config?.credentialRef),locked=!this.vault?.isUnlocked(),stale=config?.lastObservedAt&&this.clock()-Date.parse(config.lastObservedAt)>this.staleMs;const state=!configured?'unconfigured':locked?'locked':config.lastErrorCode?'unavailable':stale?'stale':config.verified?'ready':'unverified';return {configured,locked,state,baseUrl:config?.baseUrl||null,requiredScopes:[...SCOPES],readOnlyTransport:true,lastObservedAt:config?.lastObservedAt||null,lastErrorCode:config?.lastErrorCode||null,detail:state==='unconfigured'?'Save your own n8n API key with workflow:read and execution:list in the app vault.':state==='locked'?'Unlock the app vault to observe n8n.':state==='ready'?'Selected workflow metadata was observed. n8n retains execution and schedule ownership.':state==='stale'?'The last n8n observation is stale. Refresh a selected workflow.':state==='unavailable'?'The last observation failed. Earlier observations are retained; current state is unknown.':'Refresh a selected workflow to verify API access. Saving a key does not test it.'};}
 snapshot(){const config=this.meta();return {...this.status(),observations:this.store.list('automation').filter(item=>item.executor==='n8n').map(item=>{const observation=item.observation||null,stale=observation&&(observation.connectionRevision!==config?.revision||this.clock()-Date.parse(observation.observedAt)>this.staleMs);return {automationId:item.id,status:item.observationStatus==='unavailable'?'unavailable':stale?'stale':observation?'observed':'unverified',observedAt:observation?.observedAt||null,lastAttemptAt:item.lastObservationAttemptAt||null,lastErrorCode:item.lastObservationErrorCode||null,nextRefreshAt:item.nextRefreshAt||null,observation};})};}
 invalidate(){this.epoch++;for(const controller of this.controllers)controller.abort();this.controllers.clear();}
 close(){this.closed=true;this.invalidate();}
 async configure({baseUrl,apiKey,confirmed,allowLocal=false}={}){
  if(this.closed)throw fault('N8N_REVOKED','The n8n observer was closed.');if(confirmed!==true)throw fault('N8N_AUTHORITY','Confirm saving your own read-only n8n API key.',400);if(!this.vault?.isUnlocked())throw fault('N8N_VAULT_LOCKED','Unlock the app vault before configuring n8n.');if(this.configuring)throw fault('N8N_BUSY','Wait for the current n8n configuration update.');
  const selected=base(baseUrl,allowLocal);if(typeof apiKey!=='string'||!/^[\x21-\x7e]{8,8192}$/.test(apiKey))throw fault('N8N_KEY','Use your own n8n API key without spaces or extra lines.',400);
  this.configuring=true;this.invalidate();const epoch=this.epoch,vaultEpoch=this.vault.epoch,profileHash=hash(this.store.get('profile','main')),prior=this.meta(),credentialRef='n8n-key-'+randomBytes(16).toString('hex');
  try{await this.vault.put(credentialRef,binding(selected),{apiKey});if(this.closed||this.epoch!==epoch||!this.vault.isUnlocked()||this.vault.epoch!==vaultEpoch||hash(this.store.get('profile','main'))!==profileHash||hash(this.meta())!==hash(prior))throw fault('N8N_REVOKED','n8n configuration or the vault changed before setup finished.');
   this.store.transaction(()=>{this.store.put('connection',{id:META,...selected,credentialRef,revision:(prior?.revision||0)+1,verified:false,lastObservedAt:null,lastErrorCode:null,configuredAt:new Date(this.clock()).toISOString()});for(const item of this.store.list('automation'))if(item.executor==='n8n')this.store.put('automation',{...item,state:'unknown',observationStatus:item.observation?'stale':'unverified',lastObservationErrorCode:null});});return this.status();
  }finally{this.configuring=false;}
 }
 context(automationId){
  if(this.closed||this.configuring)throw fault('N8N_REVOKED','The n8n observer is closed or its configuration changed.');const config=this.meta();if(!config?.credentialRef)throw fault('N8N_UNCONFIGURED','Configure the selected read-only n8n connection first.');if(!this.vault?.isUnlocked())throw fault('N8N_VAULT_LOCKED','Unlock the app vault before observing n8n.');const selected=base(config.baseUrl,config.allowLocal);if(selected.baseUrl!==config.baseUrl||selected.origin!==config.origin||selected.basePath!==config.basePath)throw fault('N8N_INSTANCE','The stored n8n instance configuration is inconsistent.');const automation=automationFor(this.store.get('automation',automationId),config),profile=this.store.get('profile','main');return {config,automation,epoch:this.epoch,vaultEpoch:this.vault.epoch,profileHash:hash(profile),configHash:hash(config),automationHash:hash(automation)};
 }
 guard(snapshot){if(hash(snapshot.config)!==snapshot.configHash||hash(snapshot.automation)!==snapshot.automationHash)throw fault('N8N_REVOKED','The observation context changed before this read.');const current=this.context(snapshot.automation.id);for(const field of ['epoch','vaultEpoch','profileHash','configHash','automationHash'])if(current[field]!==snapshot[field])throw fault('N8N_REVOKED','The connection, vault, selected workflow or profile changed during observation.');return current;}
 async read(path,snapshot,key){
  this.guard(snapshot);const expectedWorkflow='/api/v1/workflows/'+snapshot.automation.workflowId+'?excludePinnedData=true',expectedExecutions='/api/v1/executions?'+new URLSearchParams({workflowId:snapshot.automation.workflowId,includeData:'false',limit:'5'});if(path!==expectedWorkflow&&path!==expectedExecutions)throw fault('N8N_METHOD','This observer supports only the selected workflow and execution metadata GET routes.');
  const url=snapshot.config.baseUrl+path,controller=new AbortController();this.controllers.add(controller);let timer;
  try{return await Promise.race([(async()=>{
   let addresses;if(snapshot.config.allowLocal)addresses=[{address:'127.0.0.1',family:4}];else{try{addresses=isIP(snapshot.config.hostname.replace(/^\[|\]$/g,''))?[{address:snapshot.config.hostname,family:isIP(snapshot.config.hostname)}]:await this.resolver(snapshot.config.hostname,{all:true,verbatim:true});}catch{throw fault('N8N_DESTINATION','The n8n hostname could not be resolved safely.');}if(!addresses.length||addresses.some(item=>!isIP(item.address)||privateAddress(item.address)))throw fault('N8N_DESTINATION','The n8n hostname resolved to a private or unsupported network destination.');}
   this.guard(snapshot);if(controller.signal.aborted)throw fault('N8N_REVOKED','The n8n read was cancelled.');const connectionLookup=(_host,options,callback)=>{if(typeof options==='function'){callback=options;options={};}if(options?.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family||isIP(addresses[0].address));};
   let response;try{response=await this.fetcher(url,{method:'GET',headers:{Accept:'application/json','X-N8N-API-KEY':key},signal:controller.signal,redirect:'error',credentials:'omit',lookup:connectionLookup});}catch(error){if(error.code?.startsWith('N8N_'))throw error;throw fault('N8N_UNAVAILABLE','The n8n read did not complete securely.');}this.guard(snapshot);
   if(response.redirected||response.status>=300&&response.status<400||response.url&&new URL(response.url).toString()!==url){response.body?.destroy?.();throw fault('N8N_REDIRECT','n8n redirected an authenticated read; the redirect was rejected.');}
   if(response.status===401||response.status===403){response.body?.destroy?.();throw fault(response.status===401?'N8N_AUTH_REQUIRED':'N8N_SCOPE_REQUIRED','n8n rejected this key or its workflow:read/execution:list access. Check its scopes and project permissions.');}
   if(response.status===429){response.body?.destroy?.();throw fault('N8N_REMOTE_RATE_LIMIT','n8n rate-limited the read. Wait before refreshing again.',429);}
   if(response.status!==200){response.body?.destroy?.();throw fault('N8N_UNAVAILABLE','n8n did not return the selected workflow metadata.');}
   const result=await boundedJSON(response);this.guard(snapshot);return result;
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(fault('N8N_TIMEOUT','The bounded n8n observation timed out.'));},this.timeoutMs);})]);}finally{clearTimeout(timer);controller.abort();this.controllers.delete(controller);}
 }
 async observe(automationId){
  if(this.busy)throw fault('N8N_BUSY','Wait for the current n8n metadata check.',429);const snapshot=this.context(automationId),now=this.clock(),rate=this.store.get('n8n_observer_rate',automationId);if(Date.parse(rate?.nextRefreshAt||'')>now)throw fault('N8N_RATE_LIMIT','Wait for the scoped n8n refresh interval before trying again.',429);
  const attemptedAt=new Date(now).toISOString(),nextRefreshAt=new Date(now+this.minIntervalMs).toISOString();this.store.put('n8n_observer_rate',{id:automationId,nextRefreshAt});this.busy=true;
  try{const secret=await this.vault.get(snapshot.config.credentialRef,binding(snapshot.config));this.guard(snapshot);if(typeof secret?.apiKey!=='string'||!secret.apiKey)throw fault('N8N_AUTH_REQUIRED','The protected n8n key is unavailable. Configure it again.');
   const workflow=await this.read('/api/v1/workflows/'+snapshot.automation.workflowId+'?excludePinnedData=true',snapshot,secret.apiKey);this.guard(snapshot);const executions=await this.read('/api/v1/executions?'+new URLSearchParams({workflowId:snapshot.automation.workflowId,includeData:'false',limit:'5'}),snapshot,secret.apiKey);this.guard(snapshot);const result=metadata(workflow,executions,snapshot.automation.workflowId,secret.apiKey),observedAt=new Date(this.clock()).toISOString(),observation={source:'n8n_api',connectionRevision:snapshot.config.revision,observedAt,...result};let saved;
   this.store.transaction(()=>{this.guard(snapshot);saved=this.store.put('automation',{...snapshot.automation,state:result.workflow.isArchived?'archived':result.workflow.active?'active':'inactive',observationStatus:'observed',lastObservedAt:observedAt,lastObservationAttemptAt:attemptedAt,lastObservationErrorCode:null,nextRefreshAt,observation});this.store.put('connection',{...snapshot.config,verified:true,lastObservedAt:observedAt,lastErrorCode:null});this.store.event(null,'n8n_observed',{automationId,workflowId:result.workflow.id,active:result.workflow.active,metadataOnly:true});});return saved;
  }catch(error){try{this.guard(snapshot);this.store.transaction(()=>{this.store.put('automation',{...snapshot.automation,state:'unknown',observationStatus:'unavailable',lastObservationAttemptAt:attemptedAt,lastObservationErrorCode:error.code?.startsWith('N8N_')?error.code:'N8N_UNAVAILABLE',nextRefreshAt});this.store.put('connection',{...snapshot.config,lastErrorCode:error.code?.startsWith('N8N_')?error.code:'N8N_UNAVAILABLE'});});}catch{}if(error.code?.startsWith('N8N_'))throw error;throw fault('N8N_UNAVAILABLE','The n8n observation failed. Previous observations are retained.');}finally{this.busy=false;}
 }
}
