import {randomUUID,createHash} from 'node:crypto';
const now=()=>new Date().toISOString();
const normal=s=>String(s||'').trim().toLowerCase();
const fail=message=>Object.assign(new Error(message),{status:409,code:'outcome_review'});
const allowed=new Set(['submitted','interview','assessment','rejected','offer']);
export class OutcomeService{
 constructor({store,demo=false}){this.store=store;this.demo=demo;}
 accept(proposalId,{automatic=false}={}){
  const p=this.store.get('inbox_proposal',proposalId);if(!p)throw fail('Employer message proposal not found.');
  if(p.state==='accepted')return {accepted:true,replayed:true,jobId:p.jobId};
  if(p.state!=='open')throw fail('This message proposal is no longer awaiting acceptance.');
  if(this.demo)throw fail('Live inbox evidence cannot enter the fixture workspace.');
  const job=this.store.get('job',p.jobId),profile=this.store.get('profile','main'),connection=this.store.get('connection','inbox');
  if(!job||!connection?.enabled||!connection.verified)throw fail('A verified, enabled application inbox is required.');
  if(!(connection.recipients||[connection.email]).some(address=>normal(address)===normal(profile.email))||normal(p.candidateEmail)!==normal(profile.email)||p.jobIdentity!==job.identity)throw fail('The message no longer matches this candidate and application identity.');
  if(automatic&&connection.autoTrack!==true)throw fail('Automatic inbox updates are not enabled.');
  if(p.confidence!=='matched'||!allowed.has(p.proposedOutcome))throw fail('This message needs a scoped manual review before changing an outcome.');
  const e=p.evidence;if(e?.source!=='gmail'||!p.messageId||normal(e.recipient)!==normal(profile.email)||e.employer!==job.employer||e.title!==job.title||!e.sender||!e.quote||!e.messageUrl||!Number.isFinite(Date.parse(e.receivedAt)))throw fail('The message evidence is incomplete or does not match this application.');
  const matched=e.matches;if(e.authentication!=='gmail-dmarc-header-pass'||!matched?.trustedSender||!matched.recipient||!matched.deliveryWindow||!matched.employer||!matched.role||matched.uniqueJob!==true||e.requisition&&matched.requisition!==true)throw fail('The message has not passed the exact sender, candidate, employer and role checks.');
  const messageUrl=new URL(e.messageUrl);if(messageUrl.protocol!=='https:'||messageUrl.hostname!=='mail.google.com'||messageUrl.username||messageUrl.password)throw fail('The message evidence is not a supported inbox reference.');
  // A matched proposal is produced only by the read-only adapter's exact header,
  // employer, role/requisition and outcome checks. The client supplies its ID only.
  const observedAt=now(),evidence={id:'mail-evidence-'+createHash('sha256').update(job.identity+'|'+p.messageId).digest('hex').slice(0,28),type:'employer_email',source:'authorized_inbox',jobId:job.id,identity:job.identity,candidateId:profile.id,email:profile.email,title:job.title,employer:job.employer,sender:e.sender,url:e.messageUrl,reference:p.messageId,receivedAt:e.receivedAt,observedAt,quote:e.quote.slice(0,1500),documentsVerified:false,fixture:false};
  this.store.transaction(()=>{
   const current=this.store.get('job',job.id);if(current.identity!==p.jobIdentity)throw fail('Application identity changed before outcome recording.');
   const observedTimes=(current.evidence||[]).map(x=>Date.parse(x.receivedAt||x.observedAt||x.createdAt||'')||0);const priorTime=Math.max(Date.parse(current.lastEmployerMessageAt||'')||0,...observedTimes,['interview','assessment','rejected','offer'].includes(current.state)&&!current.lastEmployerMessageAt&&!observedTimes.some(t=>t>0)?Date.parse(current.updatedAt||'')||0:0),newTime=Date.parse(e.receivedAt);const earlier=newTime<priorTime;const receiptAfterResponse=p.proposedOutcome==='submitted'&&['interview','assessment','rejected','offer'].includes(current.state);const preserveOutcome=earlier||receiptAfterResponse;
   const evidenceList=(current.evidence||[]).some(x=>x.id===evidence.id)?current.evidence:[...(current.evidence||[]),evidence];
   const priorApplication=p.proposedOutcome==='submitted'&&!current.activeAttemptId;
   this.store.put('job',{...current,state:preserveOutcome?current.state:p.proposedOutcome,evidence:evidenceList,submissionConfirmation:current.submissionConfirmation==='employer_confirmed'?current.submissionConfirmation:p.proposedOutcome==='submitted'?'employer_confirmed':current.submissionConfirmation,priorApplicationDetected:current.priorApplicationDetected||priorApplication,lastEmployerMessageAt:earlier?current.lastEmployerMessageAt:e.receivedAt,revision:(current.revision||0)+1,nextAction:preserveOutcome?current.nextAction:priorApplication?'A matching earlier employer receipt was found. Do not apply again.':p.proposedOutcome==='submitted'?'Await employer response':'Review the employer response',preparationRequested:false});
   if(current.activeAttemptId){const attempt=this.store.get('run',current.activeAttemptId);if(attempt?.dispatchedAt&&p.proposedOutcome==='submitted')this.store.put('run',{...attempt,state:'reconciled',evidenceId:evidence.id,documentsVerified:false,reconciledAt:observedAt});}
   for(const d of this.store.list('decision'))if((d.jobId===job.id||d.jobIds?.includes(job.id))&&d.state==='open'){const accountId=d.details?.accountId;const account=accountId?this.store.get('account',accountId):null;const others=[...new Set([...(d.jobIds||[]),...(account?.applicationIds||[])])].filter(id=>id!==job.id);if(others.length)this.store.put('decision',{...d,jobId:d.jobId===job.id?others[0]:d.jobId,jobIds:others});else this.store.put('decision',{...d,state:'resolved',answer:'Matching employer response superseded this application’s pending preparation',resolvedAt:observedAt});}
   this.store.put('inbox_proposal',{...p,state:'accepted',acceptedAt:observedAt,automatic,evidenceId:evidence.id});this.store.event(job.id,'employer_message_recorded',{proposalId:p.id,messageId:p.messageId,outcome:p.proposedOutcome,evidenceId:evidence.id,automatic,earlier,preservedOutcome:preserveOutcome,documentsVerified:false});
  });return {accepted:true,jobId:job.id,outcome:p.proposedOutcome,evidenceId:evidence.id};
 }
 dismiss(proposalId){const p=this.store.get('inbox_proposal',proposalId);if(!p)throw fail('Employer message proposal not found.');if(p.state==='accepted')throw fail('An accepted message is history. Record a correction instead of deleting it.');return this.store.put('inbox_proposal',{...p,state:'dismissed',dismissedAt:now()});}
}
