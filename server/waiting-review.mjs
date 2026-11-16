import {createHash} from 'node:crypto';
import {preciseDeadline} from './posting-requirements.mjs';

const DAY=24*60*60*1000;
const ended=new Set(['submitted','interview','assessment','rejected','offer','closed','cancelled']);
const open=decision=>['open','pending','needs_you'].includes(decision?.state||decision?.status||'open');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso=value=>preciseDeadline(typeof value==='string'?value:'');
const wording={
 saved_deadline_passed:{rank:0,label:'Saved deadline passed',reason:'The earliest saved application deadline has passed. Review the saved decision and recheck the posting or reconcile any manual or uncertain work. The employer portal has not been rechecked.'},
 saved_deadline_24h:{rank:1,label:'Saved deadline within 24 hours',reason:'The earliest saved application deadline is within 24 hours. Review this waiting decision. The employer portal has not been rechecked.'},
 saved_deadline_48h:{rank:2,label:'Saved deadline within 48 hours',reason:'The earliest saved application deadline is within 48 hours. Review this waiting decision. The employer portal has not been rechecked.'},
 waiting_7d:{rank:3,label:'Waiting at least 7 days',reason:'This saved decision has waited at least 7 days. Review the next action when ready. No posting refresh or application action was performed.'},
 waiting:{rank:4,label:'Waiting for your input',reason:'The saved decision is still waiting for your input. No posting refresh or application action was performed.'}
};

// Local attention is separate from decision authority: drafts/uploads fingerprint
// the entire stored decision, so even harmless authority-record writes revoke work.
export function deriveWaitingAttention(decision,jobs,{now=Date.now()}={}){
 if(!decision?.id||!open(decision)||!Number.isFinite(Number(now)))return null;
 const byId=jobs instanceof Map?jobs:new Map((jobs||[]).map(job=>[job.id,job]));
 const linkedIds=[...new Set([decision.jobId,decision.applicationId,...(Array.isArray(decision.jobIds)?decision.jobIds:[])].filter(id=>typeof id==='string'&&id))].sort();
 const linked=linkedIds.map(id=>byId.get(id)).filter(Boolean),active=linked.filter(job=>!ended.has(job.state));
 // An open shared decision can outlive one application. Only its remaining
 // nonterminal applications contribute urgency; a true global decision can age.
 if(linkedIds.length&&!active.length)return null;
 const waitingSince=iso(decision.createdAt),waitingTime=waitingSince?Date.parse(waitingSince):null;
 const candidates=active.filter(job=>job.deadlineUncertain!==true).map(job=>({job,deadline:iso(job.deadline)})).filter(item=>item.deadline).sort((a,b)=>Date.parse(a.deadline)-Date.parse(b.deadline)||a.job.id.localeCompare(b.job.id));
 const earliest=candidates[0],deadline=earliest?.deadline||null,remaining=deadline?Date.parse(deadline)-Number(now):null;
 let level='waiting';
 if(remaining!==null&&remaining<=0)level='saved_deadline_passed';
 else if(remaining!==null&&remaining<=DAY)level='saved_deadline_24h';
 else if(remaining!==null&&remaining<=2*DAY)level='saved_deadline_48h';
 else if(waitingTime!==null&&Number(now)-waitingTime>=7*DAY)level='waiting_7d';
 const ambiguous=active.find(job=>job.deadlineUncertain===true||(!iso(job.deadline)&&typeof job.deadlineLabel==='string'&&job.deadlineLabel));
 const source=earliest?.job||ambiguous||null;
 const {attention,updatedAt,...authority}=decision;
 const bindingHash=digest({version:1,decision:authority,linked:linkedIds.map(id=>{const job=byId.get(id);return job?{id:job.id,identity:job.identity||null,state:job.state,deadline:job.deadline||null,deadlineUncertain:job.deadlineUncertain===true,deadlineLabel:job.deadlineLabel||null,postingHash:job.posting?.sourceHash||null,postingDeadline:job.posting?.deadline||null,postingSourceUrl:job.posting?.sourceUrl||job.url||null}: {id,missing:true};})});
 return {version:1,level,...wording[level],deadline,deadlineUncertain:!earliest&&Boolean(ambiguous),deadlineLabel:typeof source?.deadlineLabel==='string'?source.deadlineLabel:null,jobId:earliest?.job.id||null,jobIds:active.map(job=>job.id).sort(),waitingSince,bindingHash};
}
function savedFields(value){const {deadlineLabel,...saved}=value;return saved;}

export function reviewWaitingDecisions(store,{now=Date.now()}={}){
 if(!Number.isFinite(Number(now)))throw new Error('A valid local review clock is required.');
 const stamp=new Date(Number(now)).toISOString();
 return store.transaction(()=>{
  const jobs=new Map(store.list('job').map(job=>[job.id,job]));let checked=0,changed=0,attentionCount=0;
  for(const decision of store.list('decision')){
   const current=deriveWaitingAttention(decision,jobs,{now});if(!current)continue;checked++;if(current.rank<4)attentionCount++;
   const fields=savedFields(current),previous=store.get('decision_attention',decision.id);
   if(previous?.bindingHash===fields.bindingHash&&previous.level===fields.level)continue;
   store.put('decision_attention',{id:decision.id,decisionId:decision.id,...fields,changedAt:stamp});changed++;
   if(current.rank<4||previous?.rank<4)store.event(null,'waiting_attention_changed',{decisionId:decision.id,level:current.level,previousLevel:previous?.level||null,deadline:current.deadline,jobIds:current.jobIds,bindingHash:current.bindingHash,localOnly:true});
  }
  return {checked,changed,attentionCount};
 });
}

// A result is projected only while still bound to the current open decision,
// linked applications and current time bucket. Old resolved sidecars are history.
export function projectWaitingDecision(decision,jobs,record,{now=Date.now()}={}){
 const {attention,...base}=decision||{},current=deriveWaitingAttention(decision,jobs,{now});
 if(!current||!record||record.id!==decision.id||record.decisionId!==decision.id||record.bindingHash!==current.bindingHash||record.level!==current.level)return base;
 return {...base,attention:{...current,changedAt:record.changedAt}};
}
