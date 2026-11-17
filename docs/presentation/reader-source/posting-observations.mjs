import {createHash} from 'node:crypto';
import {writingSourceUrl} from './writing-policy.mjs';

export const POSTING_OBSERVATION_LIMITS=Object.freeze({perJob:64,total:5000,bytes:512*1024,text:100000,pageSize:100});
const now=()=>new Date().toISOString();
const fail=(code,message,status=409,details={})=>Object.assign(new Error(message),{code,status,hold:true,details});
const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const identity=job=>job.identity||job.id;
const content=posting=>Object.fromEntries(Object.entries(posting).filter(([key])=>!['sourceHash','observedAt','fetchedAt'].includes(key)));
// Adapter hashes may omit employer/title metadata and time-based availability.
const observedIdentity=posting=>({title:posting?.title??null,employer:posting?.employer??null,open:posting?.open===true,expired:posting?.expired===true});

// Retain observed evidence, not arbitrary adapter/request metadata. URLs identify a
// public route; they are deliberately not a copy of an authenticated browser URL.
function publicSourceUrl(raw){
 try{
  const original=new URL(raw),safe=new URL(writingSourceUrl(raw));
  if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(original.hostname)&&original.searchParams.has('gh_jid')){
   const requisitions=original.searchParams.getAll('gh_jid');if(requisitions.length!==1||!/^\d{1,30}$/.test(requisitions[0]))throw new Error();
   safe.searchParams.set('gh_jid',requisitions[0]);
  }
  return safe.toString();
 }catch{throw fail('posting_source_url','This posting contains an unsupported source URL. Existing source versions are preserved; read a public employer route or continue manually.');}
}
function fields(value,{strings=[],booleans=[],nullable=[]}={}){
 const result={};if(!value||typeof value!=='object'||Array.isArray(value))return result;
 for(const key of strings)if(typeof value[key]==='string')result[key]=value[key];
 for(const key of booleans)if(typeof value[key]==='boolean')result[key]=value[key];
 for(const key of nullable)if(value[key]===null||typeof value[key]==='string')result[key]=value[key];
 if(Object.hasOwn(value,'sourceUrl'))result.sourceUrl=publicSourceUrl(value.sourceUrl);
 return result;
}
function projectedPosting(value){
 const result=fields(value,{strings:['title','employer','portal','text','sourceHash','observedAt','fetchedAt'],booleans:['open','expired','deadlineUncertain','fixture'],nullable:['deadline','deadlineLabel']});
 if(Array.isArray(value.requirements))result.requirements=value.requirements.filter(item=>typeof item==='string');
 if(Array.isArray(value.documents))result.documents=value.documents.map(item=>fields(item,{strings:['label','name','accept','page','coverage'],booleans:['required','multiple','visible']}));
 if(Array.isArray(value.deadlineEvidence))result.deadlineEvidence=value.deadlineEvidence.map(item=>fields(item,{strings:['source','quote']}));
 return result;
}

export class PostingObservations {
 constructor({store}){this.store=store;}
 record(job,posting,{adopt=false,reason='preparation'}={}){
  if(!job?.id||typeof posting?.sourceHash!=='string'||!posting.sourceHash||posting.sourceHash.length>200||typeof posting.text!=='string'||!posting.text.trim())throw fail('posting_required','Read the actual posting before preparing or reviewing this résumé.');
  let serialized;try{serialized=JSON.stringify(posting);}catch{throw fail('posting_required','This posting could not be retained safely. Read it again or continue manually.');}
  if(Buffer.byteLength(serialized)>POSTING_OBSERVATION_LIMITS.bytes||posting.text.length>POSTING_OBSERVATION_LIMITS.text)throw fail('posting_source_limit','This posting exceeds the retained source limit. Existing versions are preserved; continue manually.');
  const retained=projectedPosting(JSON.parse(serialized));
  if(Buffer.byteLength(JSON.stringify(retained))>POSTING_OBSERVATION_LIMITS.bytes)throw fail('posting_source_limit','This posting exceeds the retained source limit. Existing versions are preserved; continue manually.');
  const contentHash=digest(content(retained)),sourceHash=retained.sourceHash,jobIdentity=identity(job),semanticIdentity=observedIdentity(retained),id='posting-'+digest([job.id,jobIdentity,sourceHash,semanticIdentity]).slice(0,40),legacyId='posting-'+digest([job.id,jobIdentity,sourceHash]).slice(0,40);
  return this.store.transaction(()=>{
   const current=this.store.get('job',job.id);
   if(current&&(identity(current)!==jobIdentity||current.revision!==job.revision||current.posting?.sourceHash!==job.posting?.sourceHash||current.postingObservationId!==job.postingObservationId||['manual','cancelled'].includes(current.state)))throw fail('action_revoked','This application changed while the posting was read. Open its current state before continuing.');
   if(reason==='manual_selection'&&current?.latestPostingObservationId&&current.latestPostingObservationId!==current.postingObservationId)throw fail('posting_changed','A newer employer posting is waiting for review. Read the current posting before preparing this finished résumé.',409,this.changeDetails(current));
   let observation=this.store.get('postingObservation',id);
   // Keep prior package bindings valid for the same observed source/state. Never
   // reuse a hash-only row whose metadata/availability differs or rewrite it.
   if(!observation){const previous=this.store.get('postingObservation',legacyId);if(previous?.jobId===job.id&&previous.jobIdentity===jobIdentity&&previous.sourceHash===sourceHash&&digest(observedIdentity(previous.posting))===digest(semanticIdentity))observation=previous;}
   if(!observation){
    const count=this.store.db.prepare("SELECT count(*) AS count FROM documents WHERE kind='postingObservation' AND json_extract(body,'$.jobId')=?").get(job.id).count,total=this.store.db.prepare("SELECT count(*) AS count FROM documents WHERE kind='postingObservation'").get().count;
    if(count>=POSTING_OBSERVATION_LIMITS.perJob||total>=POSTING_OBSERVATION_LIMITS.total)throw fail('posting_history_limit','The retained posting-version limit was reached. Existing source versions and documents are preserved; continue manually.');
    const observedAt=Number.isFinite(Date.parse(posting.observedAt||posting.fetchedAt||''))?new Date(posting.observedAt||posting.fetchedAt).toISOString():now();
    observation=this.store.put('postingObservation',{id,jobId:job.id,jobIdentity,sourceHash,contentHash,observedAt,recordedAt:now(),reason,identityVersion:2,projectionVersion:1,textCoverage:'retained_adapter_text',urlCoverage:'sanitized_public_route',posting:retained});
    this.store.event(job.id,'posting_observed',{observationId:id,sourceHash,contentHash,reason});
   }
   if(current)this.store.put('job',{...current,latestPostingObservationId:observation.id,postingLastCheckedAt:now(),...(adopt?{postingObservationId:observation.id}:{})});
   return observation;
  });
 }
 binding(job,observation){return {jobIdentity:identity(job),observationId:observation.id,sourceHash:observation.sourceHash,contentHash:observation.contentHash};}
 assertPackage(pkg,job=this.store.get('job',pkg?.jobId)){
  const binding=pkg?.postingBinding;
  if(!binding||!job)throw fail('posting_changed','This retained résumé has no verified employer-posting version. Prepare a current version from a finished original before approving or using it.');
  const observation=this.store.get('postingObservation',binding.observationId);
  if(binding.jobIdentity!==identity(job)||binding.sourceHash!==job.posting?.sourceHash||binding.observationId!==job.postingObservationId||job.latestPostingObservationId&&job.latestPostingObservationId!==job.postingObservationId||!binding.contentHash||!observation||observation.jobId!==job.id||observation.jobIdentity!==identity(job)||observation.sourceHash!==binding.sourceHash||observation.contentHash!==binding.contentHash)throw fail('posting_changed','The employer posting changed after this résumé was prepared. Review the saved source versions, then prepare and review a current document.',409,this.changeDetails(job));
  return observation;
 }
 changeDetails(job){return {currentObservationId:job.postingObservationId||null,latestObservationId:job.latestPostingObservationId||null,packageObservationId:this.store.get('package',job.packageId||'')?.postingBinding?.observationId||null};}
 page(jobId,{limit=2,before=null}={}){
  const job=typeof jobId==='string'&&jobId.length<=2000&&this.store.get('job',jobId);if(!job)throw fail('posting_history_missing','Application not found.',404);
  if(!Number.isInteger(limit)||limit<1||limit>POSTING_OBSERVATION_LIMITS.pageSize)throw fail('posting_history_page','Use a posting history page size from 1 to 100.',400);
  const jobIdentity=identity(job),scope=digest([this.store.directory,jobId,jobIdentity]),invalid=()=>fail('posting_history_page','This posting-history page is invalid or belongs to another application or workspace. Refresh its source history.',400);
  let sequence=null;
  if(before!==null){
   let cursor;try{if(typeof before!=='string'||!before||before.length>4096||!/^[A-Za-z0-9_-]+$/.test(before))throw invalid();const bytes=Buffer.from(before,'base64url');if(bytes.toString('base64url')!==before)throw invalid();cursor=JSON.parse(bytes.toString('utf8'));}catch{throw invalid();}
   if(!cursor||typeof cursor!=='object'||Array.isArray(cursor)||Object.keys(cursor).sort().join(',')!=='observationId,scope,sequence,version'||cursor.version!==1||cursor.scope!==scope||!Number.isSafeInteger(cursor.sequence)||cursor.sequence<1||typeof cursor.observationId!=='string'||cursor.observationId.length>2000)throw invalid();
   const anchor=this.store.db.prepare("SELECT rowid AS sequence FROM documents WHERE kind='postingObservation' AND id=? AND json_extract(body,'$.jobId')=? AND json_extract(body,'$.jobIdentity')=?").get(cursor.observationId,jobId,jobIdentity);if(!anchor||anchor.sequence!==cursor.sequence)throw invalid();sequence=cursor.sequence;
  }
  const rows=sequence===null?this.store.db.prepare("SELECT rowid AS sequence,id,body FROM documents WHERE kind='postingObservation' AND json_extract(body,'$.jobId')=? AND json_extract(body,'$.jobIdentity')=? ORDER BY rowid DESC LIMIT ?").all(jobId,jobIdentity,limit+1):this.store.db.prepare("SELECT rowid AS sequence,id,body FROM documents WHERE kind='postingObservation' AND json_extract(body,'$.jobId')=? AND json_extract(body,'$.jobIdentity')=? AND rowid<? ORDER BY rowid DESC LIMIT ?").all(jobId,jobIdentity,sequence,limit+1);
  const hasMore=rows.length>limit,page=rows.slice(0,limit),last=page.at(-1),get=id=>{const value=id&&this.store.get('postingObservation',id);return value?.jobId===job.id&&value.jobIdentity===jobIdentity?value:null;};
  const currentObservation=get(job.postingObservationId),latestObservation=get(job.latestPostingObservationId||job.postingObservationId),packageObservation=get(this.store.get('package',job.packageId||'')?.postingBinding?.observationId),baseline=packageObservation||currentObservation;
  const keys=[...new Set([...Object.keys(content(baseline?.posting||{})),...Object.keys(content(latestObservation?.posting||{}))])].sort(),changedFields=baseline&&latestObservation?keys.filter(key=>digest(baseline.posting[key]??null)!==digest(latestObservation.posting[key]??null)):[];
  return {observations:page.map(row=>JSON.parse(row.body)),hasMore,nextCursor:hasMore?Buffer.from(JSON.stringify({version:1,scope,sequence:last.sequence,observationId:last.id})).toString('base64url'):null,currentObservation,latestObservation,packageObservation,currentObservationId:currentObservation?.id||null,latestObservationId:latestObservation?.id||null,packageObservationId:packageObservation?.id||null,lastCheckedAt:job.postingLastCheckedAt||null,limits:{...POSTING_OBSERVATION_LIMITS},comparison:{baselineObservationId:baseline?.id||null,currentObservationId:latestObservation?.id||null,changedFields,sourceChanged:Boolean(baseline&&latestObservation&&baseline.sourceHash!==latestObservation.sourceHash),retainedTextChanged:Boolean(baseline&&latestObservation&&baseline.posting.text!==latestObservation.posting.text)}};
 }
}
