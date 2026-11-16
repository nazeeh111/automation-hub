import {createHash} from 'node:crypto';

const clean=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const digest=value=>createHash('sha256').update(value).digest('hex');
const fault=message=>Object.assign(new Error(message),{code:'requirement_evidence',status:409});
const validAnswers=new Set(['eligible','not_eligible','uncertain']);
const mandatory=/\b(?:must|required|mandatory|minimum|eligible|eligibility|prerequisite|at least)\b|\b(?:citizens?|students?|residents?) only\b/i;
const preferred=/\b(?:preferred|preferably|bonus|nice to have|desired|desirable|not required|optional)\b/i;
const candidate=/\b(?:applicants?|candidates?|you|student|students|citizen|citizens|resident|residents|GPA|degree|major|enrolled|enrollment|graduat\w*|experience|proficien\w*|knowledge|skills?|ability|able|available|availability|authorization|authorized|sponsorship|clearance|age|qualification\w*)\b/i;
const duty=/\b(?:you will|responsibilities include|duties include|the role requires|the position requires)\b/i;
const candidateCondition=/\b(?:GPA|degree|major|enroll\w*|graduat\w*|citizen\w*|sponsor\w*|authori[sz]\w*|clearance|available|availability|minimum age)\b|\bmust (?:have|be|hold|possess|maintain)\b/i;
const instruction=/\b(?:submit|upload|attach|click|complete (?:the |this )?(?:form|application)|application deadline)\b/i;

// Classification locates an explicit constraint. It never declares the candidate
// ineligible from missing resume text, a model assessment or an inferred fact.
export function classifyRequirement(quote){
 const text=clean(quote);
 if(preferred.test(text)&&!mandatory.test(text.replace(/\bnot required\b/gi,'')))return {kind:'preferred',classification:'explicit_preference'};
 if(mandatory.test(text)&&(!(duty.test(text)||instruction.test(text))||candidateCondition.test(text)))return {kind:'mandatory',classification:'explicit_requirement'};
 return {kind:'uncertain',classification:duty.test(text)?'role_duty':instruction.test(text)?'application_instruction':candidate.test(text)?'unclassified_candidate_condition':'unclassified_posting_text'};
}
function context(job,profile){
 const text=clean(job?.posting?.text),postingHash=job?.posting?.sourceHash;
 if(!text||typeof postingHash!=='string'||!postingHash)throw fault('Read the actual posting before assessing requirements.');
 const jobIdentity=job.identity||job.id;if(!jobIdentity||!profile?.id)throw fault('Requirements need the exact application and candidate identity.');
 return {text,binding:{jobIdentity,candidateId:profile.id,postingHash,profileRevision:profile.updatedAt||null,profileHash:digest(JSON.stringify(profile))}};
}
const equalBinding=(a,b)=>Boolean(a&&b&&Object.keys(b).every(key=>a[key]===b[key]));
function collect(job,pkg,text){
 const quotes=new Map(),diagnostics=[];
 const add=(value,source)=>{const quote=clean(typeof value==='string'?value:value?.quote);if(!quote||!text.includes(quote))throw fault('A requirement has no exact quote in the actual posting. Re-read the posting before reviewing it.');if(!quotes.has(quote))quotes.set(quote,{quote,sources:[source]});else if(!quotes.get(quote).sources.includes(source))quotes.get(quote).sources.push(source);};
 if(job.posting.requirements!==undefined&&!Array.isArray(job.posting.requirements))throw fault('The posting requirement list is invalid.');
 if(pkg?.requirements!==undefined&&!Array.isArray(pkg.requirements))throw fault('The prepared requirement list is invalid.');
 for(const value of job.posting.requirements||[])add(value,'posting_requirement');
 for(const value of pkg?.requirements||[]){if(value?.kind==='uncertain'&&!clean(value.quote)){diagnostics.push({kind:'uncertain',text:clean(value.text),assessment:'unknown',reason:'No exact posting quote; diagnostic only, never eligibility proof.'});continue;}add(value,'prepared_requirement');}
 // Re-scan the actual text so manual selection and an omitted model result do
 // not erase an explicit constraint. No list slicing discards later questions.
 for(const line of String(job.posting.text).split(/\n+|(?<=[.!?])\s+(?=[A-Z])/).map(clean).filter(Boolean))if(mandatory.test(line)||preferred.test(line))add(line,'posting_text');
 if(quotes.size>1000)throw fault('This posting has too many requirement passages for a safe review. Continue manually.');
 return {passages:[...quotes.values()],diagnostics};
}
function summary(entries,binding){const unresolvedMandatory=entries.filter(entry=>entry.kind==='mandatory'&&entry.status!=='eligible');return {entries,unresolvedMandatory,ineligible:entries.filter(entry=>entry.status==='ineligible'),uncertain:entries.filter(entry=>entry.status==='uncertain'||entry.kind==='uncertain'),complete:unresolvedMandatory.length===0,postingHash:binding.postingHash,profileRevision:binding.profileRevision,jobIdentity:binding.jobIdentity};}

export function assessRequirements({job,profile,pkg,store}={}){
 // store is accepted for the integration contract, but reading resume facts or
 // free-form profile answers does not establish exact eligibility evidence.
 void store;const {text,binding}=context(job,profile);const saved=Array.isArray(job.requirementAnswers)?job.requirementAnswers:[];
 const {passages,diagnostics}=collect(job,pkg,text);const entries=passages.map(({quote,sources})=>{
  const {kind,classification}=classifyRequirement(quote),id='requirement-'+digest(binding.jobIdentity+'\0'+quote).slice(0,24);
  const proof=[...saved].reverse().find(answer=>answer.id===id&&answer.quote===quote&&validAnswers.has(answer.answer)&&equalBinding(answer.binding,binding));
  const status=proof?(proof.answer==='not_eligible'?'ineligible':proof.answer):'unanswered';
  return {id,quote,kind,classification,assessment:status==='eligible'?'supported':status==='ineligible'?'missing':'unknown',status,binding:{...binding},evidence:{source:proof?'candidate_attestation':'posting',sourceUrl:job.posting.sourceUrl||job.url||null,postingHash:binding.postingHash,sources,...(proof?{proof:{answer:proof.answer,answeredAt:proof.answeredAt,scope:'exact_requirement_and_candidate_profile'}}:{})}};
 });
 return {...summary(entries,binding),diagnostics};
}

export function resolveRequirements({job,profile,requirements,answers}={}){
 if(!Array.isArray(requirements)||!requirements.length||!answers||typeof answers!=='object'||Array.isArray(answers))throw fault('Answer the specific saved requirement questions.');
 const {binding}=context(job,profile),seen=new Set();
 for(const entry of requirements){if(!entry?.id||seen.has(entry.id)||!equalBinding(entry.binding,binding))throw fault('The requirement review is stale or ambiguous. Review the current posting and profile.');seen.add(entry.id);}
 // Recompute IDs, exact quote provenance and kind instead of trusting a UI row.
 const current=assessRequirements({job,profile,pkg:{requirements:requirements.map(entry=>({quote:entry.quote}))}});
 const byId=new Map(current.entries.map(entry=>[entry.id,entry]));
 for(const entry of requirements){const actual=byId.get(entry.id);if(!actual||actual.quote!==entry.quote||actual.kind!==entry.kind)throw fault('The requirement question changed. Review the current requirement.');}
 const updates=[];for(const [id,answer] of Object.entries(answers)){
  if(!seen.has(id)||!validAnswers.has(answer))throw fault('Choose Eligible, Not eligible or Uncertain for each specific requirement.');
  updates.push({id,quote:byId.get(id).quote,answer,binding:{...binding},answeredAt:new Date().toISOString()});
 }
 if(!updates.length)throw fault('Answer at least one specific requirement.');
 const changed=new Set(updates.map(entry=>entry.id));const requirementAnswers=[...(Array.isArray(job.requirementAnswers)?job.requirementAnswers:[]).filter(entry=>!changed.has(entry.id)),...updates];
 const result=assessRequirements({job:{...job,requirementAnswers},profile,pkg:{requirements:requirements.map(entry=>({quote:entry.quote}))}});
 return {...result,updates,requirementAnswers};
}
