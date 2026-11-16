import {reviewWaitingDecisions} from './waiting-review.mjs';
import {assessApplicationLimits,applicationEmployerKey,isApplicationReservation} from './application-limits.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { BrowserAdapter, ApplicationHold,normalizeNativeChoice,nativeAnswerFingerprint,portalFor,postingIdentity } from './adapters.mjs';
import {supportingControlFingerprint,supportingDocumentMatches} from './supporting-policy.mjs';
import {fileAccepts} from './posting-requirements.mjs';
import {assessRequirements,resolveRequirements} from './requirements.mjs';
import {questionFingerprint,writingAnswerHash} from './writing-policy.mjs';
import {deadlinePriority} from './posting-requirements.mjs';
import { accountIdentity, tenantKey } from './accounts.mjs';
import {PostingObservations} from './posting-observations.mjs';

const now=()=>new Date().toISOString();
const fail=(message,status=409)=>Object.assign(new Error(message),{status});
const terminal=new Set(['submitted','interview','assessment','rejected','offer','closed','cancelled']);
const reserved=new Set(['applying','uncertain','submitted','interview','assessment','rejected','offer']);
function requirementDetails(report){const unanswered=report.unresolvedMandatory.filter(r=>r.status==='unanswered'),pending=unanswered.length?unanswered:report.unresolvedMandatory;return {requirements:pending.slice(0,8),totalMandatoryPending:report.unresolvedMandatory.length,remainingAfterBatch:Math.max(0,report.unresolvedMandatory.length-Math.min(8,pending.length)),postingHash:report.postingHash,profileRevision:report.profileRevision,jobIdentity:report.jobIdentity,ineligible:report.ineligible.length,uncertain:report.unresolvedMandatory.filter(r=>r.status==='uncertain').length};}
function requirementMessage(report){return report.ineligible.length?'You marked a mandatory requirement as not eligible. Review it or continue manually.':report.unresolvedMandatory.some(r=>r.status==='uncertain')?'A mandatory requirement remains uncertain. Resolve the specific facts or continue manually.':'Confirm the specific mandatory requirements that have no candidate evidence yet.';}

const answerHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function scopedAnswers(job,profile) {
  const answers={},bindings={},profileHash=answerHash(profile);
  for(const [label,binding] of Object.entries(job.answerBindings||{}))if(Object.hasOwn(job.answers||{},label)&&binding.profileRevision===profile.updatedAt&&binding.profileHash===profileHash&&binding.postingHash===(job.posting?.sourceHash||null)&&binding.answerHash===answerHash(job.answers[label])&&typeof binding.questionHash==='string') {answers[label]=job.answers[label];bindings[label]=binding;}
  return {answers,bindings};
}
function retainedOutcome(current,job,profile) {
  if(current.revision===job.revision||!['submitted','interview','assessment','rejected','offer','closed'].includes(current.state))return false;
  return (current.evidence||[]).some(e=>e.jobId===job.id&&e.identity===job.identity&&e.employer===job.employer&&e.title===job.title&&String(e.email).toLowerCase()===String(profile?.email).toLowerCase()&&(e.type==='employer_email'&&e.source==='authorized_inbox'&&e.candidateId===(profile?.id||'main')||e.type==='candidate_attested_receipt'||e.type==='employer_confirmation'&&e.candidateId===(profile?.id||'main')));
}
function recordedApplicationOutcome(store,job,profile) {
  const scoped=(job.evidence||[]).filter(e=>e.jobId===job.id&&e.identity===job.identity&&e.employer===job.employer&&e.title===job.title&&(e.type==='candidate_attested_receipt'&&(!e.candidateId||e.candidateId===(profile?.id||'main'))||['employer_confirmation','employer_email'].includes(e.type)&&e.candidateId===(profile?.id||'main')&&(e.type!=='employer_email'||e.source==='authorized_inbox')));
  const evidence=scoped.filter(e=>String(e.email).toLowerCase()===String(profile?.email).toLowerCase());
  if(!evidence.length&&scoped.length)return {evidence:scoped[0],outcome:null};
  if(!evidence.length)return null;
  const outcomes=new Set(['submitted','interview','assessment','rejected','offer','closed']),events=store.list('event');
  const records=evidence.map(e=>{const event=events.findLast(event=>event.applicationId===job.id&&event.payload?.evidenceId===e.id&&['outcome_recorded','employer_message_recorded','submission_confirmed'].includes(event.type));return {evidence:e,outcome:outcomes.has(e.outcome)?e.outcome:outcomes.has(event?.payload?.outcome)?event.payload.outcome:e.type==='employer_confirmation'?'submitted':null,time:Date.parse(e.receivedAt||e.observedAt||event?.at||'')||0};}).sort((a,b)=>b.time-a.time);
  // A receipt can arrive after a later employer response. It must not erase it.
  const response=records.find(record=>record.outcome&&record.outcome!=='submitted');
  return response||records.find(record=>record.outcome)||records[0];
}
const employerKey=applicationEmployerKey;
function countReservations(store,employer) {const attempts=store.list('run');return store.list('job').filter(j=>isApplicationReservation(j,attempts)&&(!employer||employerKey(j.employer)===employerKey(employer))).length;}
function assertNoPostingReservation(store,job) {
  // Older ledgers may already contain two immutable identities for URL aliases.
  // Reconcile their actual posting identities without rewriting either history.
  let identity;try{identity=postingIdentity(job.url,portalFor(job.url));}catch{return;}
  const attempts=store.list('run');
  for(const other of store.list('job')){
    if(other.id===job.id||!isApplicationReservation(other,attempts))continue;
    let same=false;try{same=postingIdentity(other.url,portalFor(other.url))===identity;}catch{}
    if(same)throw new ApplicationHold('prior_application_uncertain','Another retained application for this exact employer posting is submitted, reserved or under manual control. Reconcile its history before continuing.',{relatedJobId:other.id});
  }
}
function isMatch(evidence,job,profile,intent) {const artifacts=value=>JSON.stringify((value||[]).map(d=>({documentId:d.documentId,hash:d.hash,questionHash:d.questionHash})).sort((a,b)=>a.questionHash.localeCompare(b.questionHash)));return artifacts(evidence?.supportingArtifacts)===artifacts(intent.uploadedSupportingArtifacts)&& evidence?.type==='employer_confirmation'&&evidence.jobId===job.id&&evidence.identity===job.identity&&evidence.candidateId===(profile.id||'main')&&String(evidence.email).toLowerCase()===String(profile.email).toLowerCase()&&evidence.title===job.title&&evidence.employer===job.employer&&evidence.attemptId===intent.id&&evidence.packageId===intent.packageId&&evidence.packageHash===intent.packageHash;}

export class Engine {
  constructor({store,directory,resumes,adapter,demo=false,intervalMs=2000,vault=null,accountAdapter=null,priorSubmissionResolver=null,supportingService=null}={}) {
    this.store=store;this.directory=directory;this.resumes=resumes;this.vault=vault;this.accountAdapter=accountAdapter;this.priorSubmissionResolver=priorSubmissionResolver;this.supportingService=supportingService;this.adapter=adapter||new BrowserAdapter({directory,accountAdapter});if(accountAdapter&&!this.adapter.accountAdapter)this.adapter.accountAdapter=accountAdapter;this.demo=demo;this.intervalMs=intervalMs;this.ownerId=randomUUID();this.lastWakeAt=Date.now();this.busy=false;this.stopping=false;this.lastWaitingReviewAt=null;
    this.postings=new PostingObservations({store});
    this.workerStartedAt=now();this.lastTickStartedAt=null;this.lastTickCompletedAt=null;this.lastTickErrorAt=null;this.lastTickErrorCode=null;this.activePhase=null;this.activeJobId=null;this.activeStartedAt=null;
    if(this.adapter.fixture&&!demo) throw fail('A synthetic adapter requires an isolated demo engine',500);
    this.store.acquireWorker?.(this.ownerId);this.recover();
  }
  recover() {
    this.store.transaction(()=>{
      // A completed dispatch has no safe automatic replay. An unfinished read/prepare can be repeated.
      for(const job of this.store.list('job')) {
        if(job.state==='applying') {
          const attempt=job.activeAttemptId&&this.store.get('run',job.activeAttemptId);
          const state=attempt?.dispatchedAt?'uncertain':'ready';
          this.store.put('job',{...job,state,revision:(job.revision||0)+1,nextAction:state==='uncertain'?'Reconcile the employer receipt before retrying':'Resume the prepared application'});
          this.store.event(job.id,'restart_recovery',{state,attemptId:attempt?.id||null});
          if(state==='uncertain') this.hold(job,'uncertain_submission','The previous browser stopped after submission dispatch. Reconcile the employer receipt before retrying.');
        } else if(job.state==='preparing') this.store.put('job',{...job,state:'imported',revision:(job.revision||0)+1,nextAction:'Resume preparation after restart'});
      }
      const campaign=this.store.get('campaign','main');
      // Restarts require an intentional resume; no unattended replay after Mac sleep/reboot.
      if(campaign.status==='running') this.store.put('campaign',{...campaign,status:'paused',revision:(campaign.revision||0)+1});
    });
  }
  start() {if(this.released)throw fail('A stopped worker cannot be restarted. Create a fresh engine.');if(this.timer)return;this.stopping=false;this.timer=setInterval(()=>this.tick().catch(()=>{}),this.intervalMs);this.timer.unref?.();}
  // Scheduler observations are in memory and are not application outcomes. A
  // completed idle/busy check proves only that a scheduling iteration returned.
  runtimeStatus(){return {workerId:this.ownerId,startedAt:this.workerStartedAt,scheduled:Boolean(this.timer),busy:this.busy,stopping:this.stopping,stopped:this.stopComplete===true,lastTickStartedAt:this.lastTickStartedAt,lastTickCompletedAt:this.lastTickCompletedAt,lastErrorCode:this.lastTickErrorCode,lastErrorAt:this.lastTickErrorAt,activePhase:this.activePhase,activeJobId:this.activeJobId,activeStartedAt:this.activeStartedAt};}
  async stop({releaseWorker=true}={}) {this.stopping=true;if(this.timer)clearInterval(this.timer);this.timer=null;if(!this.stopWork)this.stopWork=(async()=>{let failure;try{await this.adapter.close?.();}catch(error){failure=error;}if(this.inFlight)await Promise.allSettled([this.inFlight]);this.stopComplete=true;if(failure)throw failure;})();try{await this.stopWork;}finally{if(releaseWorker&&this.stopComplete)this.releaseWorker();}}
  releaseWorker(){if(this.released)return;if(!this.stopComplete)throw fail('Wait for the worker to stop before releasing application storage.');this.store.releaseWorker?.(this.ownerId);this.released=true;}
  campaign(){return this.store.get('campaign','main');}
  job(id) {const job=this.store.get('job',id);if(!job)throw fail('Application not found',404);return job;}
  hold(job,code,message,details={}) {
    const current=this.job(job.id);
    let existing=this.store.list('decision').find(d=>(details.accountId?d.details?.accountId===details.accountId:d.jobId===job.id)&&d.code===code&&d.state==='open');
    if(existing&&details.accountId&&!existing.jobIds?.includes(job.id))existing=this.store.put('decision',{...existing,jobIds:[...new Set([existing.jobId,...(existing.jobIds||[]),job.id])]});
    if(existing&&['application_limit_review','application_limit_reached','employer_limit'].includes(code)&&details.report)existing=this.store.put('decision',{...existing,details,title:message,message});
    if(existing&&code==='eligibility_review'&&details.requirements)existing=this.store.put('decision',{...existing,details,title:message,message});
    if(existing&&code==='posting_changed')existing=this.store.put('decision',{...existing,details,title:message,message});
    if(existing&&details.packageId&&(existing.details?.packageId!==details.packageId||existing.details?.hash!==details.hash)){this.store.put('decision',{...existing,state:'superseded',supersededAt:now()});existing=null;}
    const decision=existing||this.store.put('decision',{id:randomUUID(),automationId:'internships',jobId:job.id,code,title:message,message,details,state:'open',scope:details.accountId?`account:${details.accountId}`:`job:${job.id}`,jobIds:[job.id],options:['Provide answer','Continue manually','Skip for now'],deadline:job.deadline||null});
    const nextState=code==='uncertain_submission'?'uncertain':current.state==='manual'?'manual':'needs_you';
    this.store.put('job',{...current,state:nextState,nextAction:message,decisionId:decision.id});
    if(!existing)this.store.event(job.id,'needs_you',{code,decisionId:decision.id});
    return decision;
  }
  fence(job,campaign,requireEnabled=false) {
    const current=this.job(job.id),live=this.campaign();
    if(this.stopping||current.revision!==job.revision||['manual','cancelled'].includes(current.state)||live.revision!==campaign.revision||requireEnabled&&(!live.enabled||live.status!=='running')) throw new ApplicationHold('action_revoked','This action was stopped, paused or taken over.');
  }
  validateProfile(profile) {if(!profile?.fullName?.trim()||!/^\S+@\S+\.\S+$/.test(profile?.email||''))throw fail('Save your full name and application email before enabling the campaign',400);}
  validateRules(rules,{requireUnlocked=true}={}) {
    if(rules.maxReasoningCalls===undefined)rules.maxReasoningCalls=20;
    if(!Number.isInteger(rules.maxReasoningCalls)||rules.maxReasoningCalls<1||rules.maxReasoningCalls>500)throw fail('Resume reasoning limit must be a whole number from 1 to 500',400);
    if(!Number.isInteger(rules.maxApplications)||rules.maxApplications<1||rules.maxApplications>500)throw fail('Application limit must be a whole number from 1 to 500',400);
    if(!Number.isInteger(rules.maxPerEmployer)||rules.maxPerEmployer<1||rules.maxPerEmployer>rules.maxApplications)throw fail('Employer limit must be between 1 and the application limit',400);
    if(!Array.isArray(rules.allowedHosts)||!rules.allowedHosts.length||rules.allowedHosts.some(h=>typeof h!=='string'||!h||h.includes('/')||h.includes(':')||h.includes('*')||h!==h.toLowerCase()||!/[a-z0-9]/.test(h)||!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(h)))throw fail('Add exact lowercase employer portal hosts to the campaign rules',400);
    if(rules.allowAccountCreation&&(!this.accountAdapter||!this.vault||(requireUnlocked&&!this.vault.isUnlocked())))throw fail('Employer account creation requires a configured and unlocked app vault and account adapter',400);
  }
  async action(name,body={}) {
    const campaign=this.campaign();
    if(name==='savePolicy') {
      const rules={...campaign.rules,...body.rules};this.validateRules(rules);
      return this.store.put('campaign',{...campaign,rules,enabled:false,status:'draft',revision:(campaign.revision||0)+1});
    }
    if(name==='enableCampaign') {
      if(body.confirmed!==true)throw fail('Explicit campaign enablement is required',400);
      this.validateProfile(this.store.get('profile','main'));this.validateRules(campaign.rules);
      if(!this.store.list('job').length)throw fail('Import at least one selected job first',400);
      if(!this.store.list('resume').some(r=>!r.mega))throw fail('Import an application-ready resume first',400);
      const saved=this.store.put('campaign',{...campaign,enabled:true,status:'running',enabledAt:now(),revision:(campaign.revision||0)+1,profileRevision:this.store.get('profile','main').updatedAt});
      this.accountAdapter?.resumeCreationPolicy();this.store.event(null,'campaign_enabled',{revision:saved.revision,rules:saved.rules,demo:this.demo});return saved;
    }
    if(name==='pause'||name==='cancel') {
      const saved=this.store.put('campaign',{...campaign,status:name==='pause'?'paused':'cancelled',enabled:name==='pause'?campaign.enabled:false,revision:(campaign.revision||0)+1});
      this.store.event(null,`campaign_${name}`,{revision:saved.revision,detail:'Prevents new dispatch. An already dispatched application may still finish.'});
      return saved;
    }
    if(name==='resume') {
      if(!campaign.enabled||campaign.status==='cancelled')throw fail('Enable a campaign with current rules before resuming');
      this.validateRules(campaign.rules);this.validateProfile(this.store.get('profile','main'));
      return this.store.put('campaign',{...campaign,status:'running',revision:(campaign.revision||0)+1});
    }
    if(name==='prepare') {
      if(body.jobId) {const job=this.job(body.jobId);if(!['imported','failed','ready','needs_you'].includes(job.state))throw fail('This application cannot be prepared in its current state');if(job.state==='needs_you'&&this.store.list('decision').some(d=>(d.jobId===job.id||d.jobIds?.includes(job.id))&&d.state==='open'))throw fail('Resolve the saved decision first');this.store.put('job',{...job,preparationRequested:true,state:'imported',nextAction:'Queued for preparation'});}
      else for(const job of this.store.list('job'))if(['imported','failed'].includes(job.state))this.store.put('job',{...job,preparationRequested:true,state:'imported',nextAction:'Queued for preparation'});
      return {queued:true};
    }
    if(name==='retry') {
      const job=this.job(body.jobId);
      if(job.state==='uncertain'||job.activeAttemptId&&this.store.get('run',job.activeAttemptId)?.dispatchedAt)throw fail('Reconcile the employer receipt before retrying a dispatched application');
      if(!['failed','needs_you'].includes(job.state))throw fail('Only a failed or waiting application can be retried');
      if((job.failures||0)>=3)throw fail('Retry limit reached. Continue manually or resolve the underlying problem');
      const retryable=new Set(['model_unavailable','model_busy','destination_not_allowed','campaign_limit','employer_limit','profile_changed','resume_missing','resume_verification','resume_review','editable_source_needed','preparation_hold','parser_changed_values','attachment_changed','form_changed','posting_required','posting_changed','identity_changed','account_busy','account_settings','account_creation_disabled','application_limit_review','application_limit_reached','resume_file_requirements','form_not_ready']);
      const open=this.store.list('decision').filter(d=>(d.jobId===job.id||d.jobIds?.includes(job.id))&&d.state==='open');
      if(open.some(d=>!retryable.has(d.code)))throw fail('Resolve the saved question, document review or eligibility decision before retrying');
      for(const decision of open)this.store.put('decision',{...decision,state:'resolved',answer:'Underlying problem will be rechecked',resolvedAt:now()});
      return this.store.put('job',{...job,state:'imported',revision:(job.revision||0)+1,nextAction:'Retry queued',preparationRequested:true});
    }
    if(name==='takeover') {
      const job=this.job(body.jobId);if(terminal.has(job.state))throw fail('This application is already finished');
      return this.store.put('job',{...job,state:'manual',revision:(job.revision||0)+1,nextAction:'Continue in the employer site. Save the matching receipt here before returning.',takenOverAt:now()});
    }
    if(name==='release') {
      const job=this.job(body.jobId);if(job.state!=='manual')throw fail('This application is not under manual control');
      // The hub cannot know what a human changed or submitted externally.
      return this.hold({...job},'manual_reconciliation','Confirm what happened during manual control before the worker resumes.',{options:['Not submitted; discard prepared form','Submitted; attach matching receipt','Keep manual control']});
    }
    if(name==='resolveDecision')return this.resolve(body);
    if(name==='recordOutcome')return this.recordOutcome(body);
    throw fail('Unsupported queue action',400);
  }
  reviewPackage({packageId,approved,decisionId}={}) {
    if(typeof approved!=='boolean')throw fail('Choose whether to approve this exact document.',400);
    return this.store.transaction(()=>{
      const pkg=this.store.get('package',packageId);
      if(!pkg?.verified)throw fail('No verified resume package is available.',404);
      const job=this.store.get('job',pkg.jobId),profile=this.store.get('profile','main');
      if(!job||job.packageId!==pkg.id||!['needs_you','ready'].includes(job.state)||job.priorApplicationDetected===true||['employer_confirmed','candidate_attested','fixture'].includes(job.submissionConfirmation)||recordedApplicationOutcome(this.store,job,profile)||this.store.get('run',job.activeAttemptId||'')?.dispatchedAt)throw fail('This package is no longer awaiting review. Open the application’s current state before changing its document.');
      if(decisionId){
        const decision=this.store.get('decision',decisionId);
        if(!decision||decision.state!=='open'||decision.code!=='package_review'||decision.jobId!==job.id||decision.details?.packageId!==pkg.id||decision.details?.hash&&decision.details.hash!==pkg.hash)throw fail('This resume review refers to an older package. Review the current package instead.');
      }
      if(approved)try{this.postings.assertPackage(pkg,job);this.resumes.assertPackageCurrent?.(pkg,profile);}catch(error){if(error.code==='resume_review')throw fail(error.message);throw error;}
      const saved=this.store.put('package',{...pkg,approved,approvedAt:approved?now():null});
      for(const d of this.store.list('decision'))if(d.jobId===job.id&&d.code==='package_review'&&d.state==='open'&&d.details?.packageId===pkg.id&&(!d.details.hash||d.details.hash===pkg.hash))this.store.put('decision',{...d,state:'resolved',answer:approved?'approve':'decline',resolvedAt:now()});
      const other=this.store.list('decision').find(d=>(d.jobId===job.id||d.jobIds?.includes(job.id))&&d.state==='open');
      this.store.put('job',{...job,state:approved&&!other?'ready':'needs_you',revision:(job.revision||0)+1,nextAction:other?(other.message||other.title||'Resolve the saved decision'):approved?'Ready for enabled campaign':'Choose or prepare another resume',decisionId:other?.id||null});
      return saved;
    });
  }
  resolve({decisionId,answer,writingReviews={}}) {
    const decision=this.store.get('decision',decisionId);if(!decision)throw fail('Decision not found',404);
    if(decision.state==='resolved')return decision;
    if(answer===undefined||answer===null||answer==='')throw fail('Provide an answer or explicitly choose none',400);
    const job=this.job(decision.jobId);
    if(['uncertain_submission','manual_reconciliation'].includes(decision.code)) {
      if(answer==='not_submitted'&&!this.store.get('run',job.activeAttemptId||'')?.dispatchedAt) {
        this.store.put('job',{...job,state:job.packageId?'ready':'imported',revision:(job.revision||0)+1,nextAction:'Resume after manual review',preparationRequested:true});
      } else if(answer==='keep_manual')this.store.put('job',{...job,state:'manual',nextAction:'Continue manually'});
      else throw fail('A dispatched or manually submitted application requires a matching employer receipt via Record outcome. It cannot be cleared with a generic answer');
    } else {
      let updated={...job};
      if(['account_consent','account_consent_declined'].includes(decision.code)){const account=this.store.get('account',decision.details?.accountId);if(!account||!this.accountAdapter)throw fail('The employer account is unavailable');return this.accountAdapter.recordConsent(account,decision.details?.questions||[],answer);
      } else if(decision.code==='posting_identity') {
        if(!answer?.title?.trim()||!answer?.employer?.trim())throw fail('Provide the exact employer and role from the posting',400);
        updated={...updated,title:answer.title.trim(),employer:answer.employer.trim(),identityConfirmed:true};
      } else if(decision.code==='form_questions') {
        if(typeof answer!=='object'||Array.isArray(answer))throw fail('Provide employer question labels and their answers',400);
        const questions=decision.details?.questions||[];if(!questions.length)throw fail('This employer form needs a specific field review before it can continue.',400);const labels=questions.map(q=>q.label);if(new Set(labels).size!==labels.length)throw fail('This form has ambiguous repeated question labels. Continue it manually.',400);
        const profile=this.store.get('profile','main'),pkg=this.store.get('package',job.packageId||'');updated.writingApprovals={...job.writingApprovals};const accepted={},choiceConsents={};
        for(const q of questions){if(!Object.hasOwn(answer,q.label))throw fail('Answer each displayed question or explicitly leave an optional field blank.',400);const value=answer[q.label];if(value===null){if(q.required===true)throw fail('A required employer question cannot be left blank.',400);accepted[q.label]=null;delete updated.writingApprovals[q.label];continue;}if(value===undefined||typeof value==='string'&&!value.trim())throw fail('Provide an answer, or use Leave blank for an optional field.',400);if(q.kind==='document'){if(!value||typeof value!=='object'||Array.isArray(value)||typeof value.documentId!=='string'||Object.keys(value).some(key=>key!=='documentId'))throw fail('Choose the reviewed file attached to this exact employer question.',400);const questionHash=supportingControlFingerprint(q),ref=job.supportingDocuments?.[questionHash],document=this.store.get('supportingDocument',value.documentId);if(!ref||!document||ref.documentId!==document.id||ref.hash!==document.hash||!supportingDocumentMatches(document,{job,profile,question:q})||!fileAccepts({accept:q.accept,name:document?.name,mime:document?.mime}))throw fail('This supporting file is missing, stale or belongs to another application question. Reattach and review the exact current file.',400);accepted[q.label]={documentId:document.id};continue;}if(q.kind==='choice'){if(typeof q.name!=='string'||!q.sourceUrl||!['select','radio'].includes(q.type))throw fail('This choice is missing its actual employer control metadata.',400);const options=q.options;if(typeof value!=='string'||!Array.isArray(options)||!options.length||options.length>500||options.some(option=>typeof option.label!=='string'||!option.label||typeof option.value!=='string'||!option.value)||new Set(options.map(option=>normalizeNativeChoice(option.label))).size!==options.length)throw fail('This employer choice needs its actual unambiguous native options.',400);const choice=options.find(option=>normalizeNativeChoice(option.label)===normalizeNativeChoice(value));if(!choice)throw fail('Choose one of this employer’s actual options. Other answers cannot be invented.',400);accepted[q.label]=choice.label;if(q.consentHash)choiceConsents[q.label]={answer:choice.label,postingHash:job.posting?.sourceHash||null,consentHash:q.consentHash,approvedAt:now()};continue;}if(q.kind==='consent'&&typeof value!=='boolean')throw fail('Employer consent requires an explicit yes or no.',400);
          if(['writing','writing_review'].includes(q.kind)){if(typeof value!=='string')throw fail('Writing answers must be text.',400);if(q.minLength!==null&&Number.isInteger(q.minLength)&&q.minLength>=0&&value.length<q.minLength||q.maxLength!==null&&Number.isInteger(q.maxLength)&&q.maxLength>=0&&value.length>q.maxLength)throw fail('The writing length does not match the employer’s question limits.',400);if(writingReviews?.[q.label]!==true)throw fail('Review the exact written answer before saving it for this employer question.',400);if(!job.posting?.sourceHash||!pkg?.hash||!profile?.updatedAt)throw fail('Prepare the current posting, resume and profile before reviewing writing.',400);updated.writingApprovals[q.label]={answerHash:writingAnswerHash(value),questionHash:questionFingerprint(q),postingHash:job.posting.sourceHash,packageHash:pkg.hash,profileRevision:profile.updatedAt,approvedAt:now()};}accepted[q.label]=value;}
        updated.answers={...job.answers,...accepted};updated.answerBindings={...job.answerBindings};for(const q of questions)if(Object.hasOwn(accepted,q.label))updated.answerBindings[q.label]={profileRevision:profile.updatedAt,profileHash:answerHash(profile),postingHash:job.posting?.sourceHash||null,questionHash:nativeAnswerFingerprint(q),answerHash:answerHash(accepted[q.label]),savedAt:now()};updated.consentApprovals={...job.consentApprovals,...choiceConsents};for(const q of questions)if(q.kind==='consent'&&Object.hasOwn(accepted,q.label))updated.consentApprovals[q.label]={answer:accepted[q.label],postingHash:job.posting?.sourceHash||null,consentHash:q.consentHash,approvedAt:now()};
      } else if(['sensitive_eligibility','eligibility_review'].includes(decision.code)) {
        if(!answer||typeof answer!=='object'||Array.isArray(answer))throw fail('Answer each specific requirement as Eligible, Not eligible or Uncertain.',400);const batch=decision.details?.requirements||[];if(!batch.length||Object.keys(answer).some(id=>!batch.some(r=>r.id===id)))throw fail('Answer only the exact displayed requirement questions.',400);const entries=new Map((job.requirementLedger||[]).map(r=>[r.id,r]));for(const r of batch)entries.set(r.id,r);const profile=this.store.get('profile','main'),pkg=this.store.get('package',job.packageId||''),resolved=resolveRequirements({job,profile,requirements:[...entries.values()],answers:answer});let savedJob=this.store.put('job',{...job,requirementAnswers:resolved.requirementAnswers,requirementLedger:resolved.entries,revision:(job.revision||0)+1,state:job.state==='manual'?'manual':resolved.unresolvedMandatory.length?'needs_you':job.packageId?'ready':'imported',preparationRequested:job.state!=='manual'&&!resolved.unresolvedMandatory.length,nextAction:job.state==='manual'?'Manual control retained. Reconcile the employer form before returning control.':resolved.unresolvedMandatory.length?requirementMessage(resolved):'Requirements reviewed; continue current application'});this.store.event(job.id,'requirements_answered',{decisionId:decision.id,updates:resolved.updates});if(resolved.unresolvedMandatory.length)return this.store.put('decision',{...decision,state:'open',details:requirementDetails(resolved),title:requirementMessage(resolved),message:requirementMessage(resolved)});const savedDecision=this.store.put('decision',{...decision,state:'resolved',answer,resolvedAt:now()});const other=this.store.list('decision').find(d=>d.id!==decision.id&&d.state==='open'&&(d.jobId===job.id||d.jobIds?.includes(job.id)));if(other)this.store.put('job',{...savedJob,state:savedJob.state==='manual'?'manual':'needs_you',preparationRequested:savedJob.state==='manual'?false:savedJob.preparationRequested,decisionId:other.id,nextAction:savedJob.state==='manual'?'Manual control retained. Reconcile the employer form before returning control.':other.message||other.title||'Resolve the saved decision'});return savedDecision;
      } else if(decision.code==='employer_rules') {
        if(answer!=='continue_manually')throw fail('Employer automation or assessment restrictions require manual completion.',400);updated.state='manual';updated.nextAction='Continue manually under the employer’s rules and retain the matching receipt';
      } else if(decision.code==='package_review') {
        if(answer!=='approve')throw fail('Review and approve the exact resume package before continuing',400);
        this.reviewPackage({packageId:job.packageId,approved:true,decisionId:decision.id});
        this.store.event(job.id,'decision_resolved',{decisionId:decision.id,code:decision.code});
        return this.store.get('decision',decision.id);
      } else if(['account_access','security_challenge','unsupported_portal','custom_form_controls','application_limit_review','application_limit_reached'].includes(decision.code)) {
        if(answer!=='continue_manually')throw fail('This portal step requires manual completion');
        updated.state='manual';updated.nextAction='Continue manually and retain a matching employer receipt';
      } else {throw fail('Resolve the underlying setup or document problem, then use Retry. A generic answer cannot clear this hold.');}
      this.store.put('job',{...updated,state:updated.state==='manual'?'manual':job.packageId?'ready':'imported',revision:(job.revision||0)+1,preparationRequested:true,nextAction:updated.state==='manual'?updated.nextAction:'Resume after your decision',decisionId:null});
    }
    const remaining=decision.details?.accountId?[...new Set([decision.jobId,...(decision.jobIds||[])])].filter(id=>id!==job.id):[];
    const saved=remaining.length?this.store.put('decision',{...decision,jobId:remaining[0],jobIds:remaining}):this.store.put('decision',{...decision,state:'resolved',answer,resolvedAt:now()});this.store.event(job.id,'decision_resolved',{decisionId:decision.id,code:decision.code});return saved;
  }
  recordOutcome({jobId,outcome,evidence}) {
    const job=this.job(jobId),profile=this.store.get('profile','main');
    if(!['submitted','interview','assessment','rejected','offer','closed'].includes(outcome))throw fail('Unsupported outcome',400);
    if(!evidence?.url||!evidence?.reference||!evidence?.employer||!evidence?.title||!evidence?.email)throw fail('Include the receipt URL, reference, employer, role and application email',400);
    const u=new URL(evidence.url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw fail('Receipt URL is invalid',400);
    if(evidence.employer!==job.employer||evidence.title!==job.title||String(evidence.email).toLowerCase()!==String(profile.email).toLowerCase())throw fail('The receipt does not match this employer, role and candidate',400);
    const recorded={...evidence,id:randomUUID(),type:'candidate_attested_receipt',outcome,candidateId:profile.id||'main',observedAt:now(),jobId:job.id,identity:job.identity,fixture:this.demo,documentsVerified:false};
    // Candidate-attested evidence is visible as such; it is never an automatically confirmed submission.
    const saved=this.store.put('job',{...job,state:outcome,nextAction:outcome==='submitted'?'Await employer response':'Review the employer response',evidence:[...(job.evidence||[]),recorded],submissionConfirmation:job.submissionConfirmation||'candidate_attested',revision:(job.revision||0)+1});
    for(const decision of this.store.list('decision'))if((decision.jobId===job.id||decision.jobIds?.includes(job.id))&&decision.state==='open'){const remaining=[...new Set([decision.jobId,...(decision.jobIds||[])])].filter(id=>id!==job.id);if(decision.details?.accountId&&remaining.length)this.store.put('decision',{...decision,jobId:remaining[0],jobIds:remaining});else this.store.put('decision',{...decision,state:'resolved',answer:'Receipt recorded',resolvedAt:now()});}
    this.store.event(job.id,'outcome_recorded',{outcome,evidenceId:recorded.id,source:'candidate_attested'});return saved;
  }
  async tick() {
    if(this.stopping)return {busy:this.busy};
    this.lastTickStartedAt=now();let tickFailed=false;
    try{
    const localNow=Date.now();if(this.lastWaitingReviewAt===null||localNow<this.lastWaitingReviewAt||localNow-this.lastWaitingReviewAt>=60000){reviewWaitingDecisions(this.store,{now:localNow});this.lastWaitingReviewAt=localNow;}
    const wakeGap=localNow-this.lastWakeAt;this.lastWakeAt=localNow;
    if(wakeGap>300000&&this.campaign().status==='running') {const c=this.campaign();this.store.put('campaign',{...c,status:'paused',revision:(c.revision||0)+1});this.store.event(null,'sleep_recovery',{detail:'Campaign paused after the computer was inactive. Resume when ready.'});}
    if(this.busy||this.stopping)return {busy:this.busy};
    const campaign=this.campaign(),active=campaign.enabled&&campaign.status==='running';
    const jobs=this.store.list('job');
    const reasoningBusy=this.resumes.model?.busy===true;
    const job=deadlinePriority(jobs.filter(j=>j.state==='ready'&&active||j.state==='imported'&&(active||j.preparationRequested)&&(!reasoningBusy||!!j.selectedResumeId)))[0];
    if(!job)return {idle:true};
    this.busy=true;
    this.activePhase=job.state==='ready'?'apply':'prepare';this.activeJobId=job.id;this.activeStartedAt=now();
    const work=job.state==='ready'?this.apply(job,campaign):this.prepare(job,campaign);this.inFlight=work;
    try {return await work;}
    finally {if(this.inFlight===work){this.inFlight=null;this.activePhase=null;this.activeJobId=null;this.activeStartedAt=null;}this.busy=false;}
    }catch(error){
      tickFailed=true;this.lastTickErrorAt=now();this.lastTickErrorCode='WORKER_TICK_FAILED';
      // Never copy exception text or arbitrary adapter error codes into status.
      // Direct callers retain the original rejection; the existing timer catch
      // consumes it only after this bounded observation has been recorded.
      throw error;
    }finally{if(!tickFailed)this.lastTickCompletedAt=now();}
  }
  reviewApplicationLimits(job,profile=this.store.get('profile','main')){const current=this.job(job.id);if(current.revision!==job.revision)throw fail('The application changed while its employer limits were being checked.');const report=assessApplicationLimits({job,profile,jobs:this.store.list('job'),attempts:this.store.list('run'),userCap:this.campaign().rules.maxPerEmployer});const saved=this.store.put('job',{...current,applicationLimitReport:report});if(!report.allowed)this.hold(saved,report.needsReview?'application_limit_review':report.confirmed.length?'application_limit_reached':'employer_limit',report.nextAction,{report,manualOnly:report.needsReview});else for(const decision of this.store.list('decision'))if(decision.jobId===job.id&&decision.state==='open'&&['application_limit_review','application_limit_reached','employer_limit'].includes(decision.code))this.store.put('decision',{...decision,state:'resolved',answer:'Employer limits rechecked against current source evidence and reservations',resolvedAt:now()});return report;}
  reviewRequirements(job,pkg,profile=this.store.get('profile','main')) {const current=this.job(job.id);if(current.revision!==job.revision)throw fail('The application changed while its requirements were being reviewed.');const report=assessRequirements({job,profile,pkg,store:this.store});const saved=this.store.put('job',{...current,requirementLedger:report.entries,requirementDiagnostics:report.diagnostics||[]});if(report.unresolvedMandatory.length)this.hold(saved,'eligibility_review',requirementMessage(report),requirementDetails(report));return report;}
  async prepare(job,campaign) {
    const profile=this.store.get('profile','main');
    this.store.put('job',{...job,state:'preparing',preparationRequested:false,nextAction:'Read the posting and prepare a grounded resume'});
    try {
      const posting=await this.adapter.inspect(job,{policy:campaign.rules,profile,authorized:campaign.enabled&&campaign.status==='running',guard:()=>this.fence(job,campaign,true)});this.fence(job,campaign);
      const postingObservation=this.postings.record(job,posting,{adopt:true,reason:'preparation'});
      if(!posting.open) {this.store.put('job',{...this.job(job.id),state:'closed',title:posting.title||job.title,employer:posting.employer||job.employer,posting,deadline:posting.deadline||null,deadlineLabel:posting.deadlineLabel||null,deadlineUncertain:posting.deadlineUncertain===true,deadlineEvidence:posting.deadlineEvidence||[],nextAction:posting.expired?'Posting deadline passed; no application submitted':'Posting closed; no application submitted'});return {closed:true};}
      let tenant;try{tenant=tenantKey(job.url)}catch{tenant=new URL(job.url).hostname}
      if(job.posting?.sourceHash===posting.sourceHash)posting.documents=[...(posting.documents||[]),...(job.posting.documents||[]).filter(d=>d.page==='application')];
      job=this.store.put('job',{...this.job(job.id),deadline:posting.deadline||null,deadlineLabel:posting.deadlineLabel||null,deadlineUncertain:posting.deadlineUncertain===true,deadlineEvidence:posting.deadlineEvidence||[],title:posting.title,employer:posting.employer,portal:posting.portal,posting,tenant,nextAction:'Compare supported resume evidence'});
      if(this.priorSubmissionResolver){let prior;try{prior=await this.priorSubmissionResolver(job,profile);}catch{prior={status:'unavailable'};}const observed=this.job(job.id);if(prior?.alreadyApplied&&reserved.has(observed.state))return {alreadyApplied:true};this.fence(job,campaign);job=this.store.put('job',{...observed,priorApplicationCheck:{status:prior?.status||'unknown',observedAt:now()}});if(prior?.alreadyApplied)throw new ApplicationHold('prior_application_uncertain','A previous application was reported but has no matching saved receipt. Reconcile before continuing.');}else job=this.store.put('job',{...job,priorApplicationCheck:{status:'unconfigured',observedAt:now()}});
      const applicationLimitReport=this.reviewApplicationLimits(job,profile);if(!applicationLimitReport.allowed)return {waiting:true,applicationLimits:true};
      const pkg=job.selectedResumeId?await this.resumes.select(job,job.selectedResumeId):await this.resumes.prepare(job,{...profile,answers:{...profile.answers,...scopedAnswers(job,profile).answers}});this.fence(job,campaign);
      if(!pkg?.id||!pkg.verified||!pkg.hash||!pkg.finalPath)throw new ApplicationHold('resume_verification','The resume package did not pass document verification.');
      if(campaign.rules.autoApproveUnchanged===true&&(!pkg.changes||pkg.changes.length===0)&&this.store.get('resume',pkg.resumeId)&&!this.store.get('resume',pkg.resumeId).mega) {pkg.approved=true;pkg.approvalSource='campaign_unchanged_reuse';pkg.approvedAt=now();}
      const postingBinding=this.postings.binding(job,postingObservation);
      if(pkg.postingBinding&&Object.entries(postingBinding).some(([key,value])=>pkg.postingBinding[key]!==value))throw new ApplicationHold('posting_changed','The prepared résumé belongs to a different employer-posting version. Prepare this application again.',this.postings.changeDetails(this.job(job.id)));
      pkg.postingBinding=postingBinding;this.store.put('package',{...pkg,jobId:job.id,profileRevision:profile.updatedAt});
      for(const decision of this.store.list('decision'))if(decision.jobId===job.id&&decision.code==='posting_changed'&&decision.state==='open')this.store.put('decision',{...decision,state:'resolved',answer:'A new document was prepared against this observed posting version',resolvedObservationId:postingObservation.id,resolvedAt:now()});
      job=this.store.put('job',{...this.job(job.id),packageId:pkg.id});const requirementReport=this.reviewRequirements(job,pkg,profile);
      if(requirementReport.unresolvedMandatory.length)return {waiting:true,requirements:true};
      job=this.store.put('job',{...this.job(job.id),packageId:pkg.id,state:'ready',nextAction:pkg.approved?'Ready for enabled campaign':'Review the exact final resume',preparationRequested:false});
      this.store.event(job.id,'package_prepared',{packageId:pkg.id,resumeId:pkg.resumeId,hash:pkg.hash});
      if(!pkg.approved)this.hold(job,'package_review','Review the exact final resume before it can be submitted.',{packageId:pkg.id,hash:pkg.hash});
      return {prepared:true,packageId:pkg.id};
    } catch(error) {return this.handleError(job,error,'preparation');}
  }
  async apply(job,campaign) {
    const profile=this.store.get('profile','main'),pkg=this.store.get('package',job.packageId||'');
    try {
      const prior=recordedApplicationOutcome(this.store,this.job(job.id),profile);
      if(prior){if(!prior.outcome)throw new ApplicationHold('prior_application_uncertain','A matching earlier employer record exists. Reconcile it before another submission.');const current=this.job(job.id);this.store.put('job',{...current,state:prior.outcome,revision:(current.revision||0)+1,preparationRequested:false,nextAction:prior.outcome==='submitted'?'Await employer response':'Review the employer response'});this.store.event(job.id,'prior_outcome_retained',{outcome:prior.outcome,evidenceId:prior.evidence.id});return {alreadyApplied:true,state:prior.outcome};}
      this.validateProfile(profile);this.validateRules(campaign.rules,{requireUnlocked:false});this.fence(job,campaign,true);
      assertNoPostingReservation(this.store,job);
      const blocker=this.store.list('decision').find(d=>(d.jobId===job.id||d.jobIds?.includes(job.id))&&d.state==='open');
      if(blocker){this.store.put('job',{...this.job(job.id),state:'needs_you',decisionId:blocker.id,nextAction:blocker.message||blocker.question||blocker.title||'Resolve the saved decision before submitting'});return {waiting:true};}
      if(campaign.profileRevision&&campaign.profileRevision!==profile.updatedAt)throw new ApplicationHold('profile_changed','Your profile changed after campaign enablement. Re-enable the campaign with the current profile.');
      if(pkg?.profileRevision&&pkg.profileRevision!==profile.updatedAt)throw new ApplicationHold('profile_changed','Your profile changed after resume preparation. Prepare this application again before submitting.');
      if(!pkg?.verified||!pkg.approved||pkg.jobId!==job.id)throw new ApplicationHold('package_review','Review the exact final resume before it can be submitted.',{packageId:job.packageId,hash:pkg?.hash});
      if(!job.posting?.open||!job.posting?.sourceHash)throw new ApplicationHold('posting_required','Read and verify the actual open posting before submitting.');
      const guard=()=>{this.fence(job,campaign,true);this.postings.assertPackage(pkg,this.job(job.id));this.resumes.assertPackageCurrent?.(pkg,this.store.get('profile','main'));};guard();
      const refreshed=await this.adapter.inspect(job,{policy:campaign.rules,profile,authorized:true,guard});guard();
      const refreshedObservation=this.postings.record(job,refreshed,{adopt:!refreshed.open,reason:'submission_check'});
      if(refreshed.title!==job.title||refreshed.employer!==job.employer)throw new ApplicationHold('posting_changed','The employer or role changed after preparation. Review the saved source versions before proceeding.',this.postings.changeDetails(this.job(job.id)));
      if(!refreshed.open){this.store.put('job',{...this.job(job.id),state:'closed',posting:refreshed,deadline:refreshed.deadline||null,deadlineLabel:refreshed.deadlineLabel||null,deadlineUncertain:refreshed.deadlineUncertain===true,deadlineEvidence:refreshed.deadlineEvidence||[],nextAction:refreshed.expired?'Posting deadline passed before submission; no application submitted':'Posting closed before submission; no application submitted'});return {closed:true};}
      if(refreshed.sourceHash!==job.posting.sourceHash||refreshedObservation.id!==job.postingObservationId)throw new ApplicationHold('posting_changed','The employer posting changed after preparation. Review the saved source versions and prepare it again before submitting.',this.postings.changeDetails(this.job(job.id)));
      const requirementReport=this.reviewRequirements({...job,posting:refreshed},pkg,profile);if(requirementReport.unresolvedMandatory.length)return {waiting:true,requirements:true};
      const applicationLimitReport=this.reviewApplicationLimits({...job,posting:refreshed},profile);if(!applicationLimitReport.allowed)return {waiting:true,applicationLimits:true};
      const host=new URL(job.url).hostname;
      if(!campaign.rules.allowedHosts.includes(host))throw new ApplicationHold('destination_not_allowed',`Add ${host} to the campaign rules before submitting.`);
      if(countReservations(this.store)>=campaign.rules.maxApplications)throw new ApplicationHold('campaign_limit','The campaign application limit has been reached.');
      if(countReservations(this.store,job.employer)>=campaign.rules.maxPerEmployer)throw new ApplicationHold('employer_limit','The employer application limit has been reached.');
      const previous=this.store.list('run').find(r=>r.identity===job.identity&&r.dispatchedAt&&!r.retiredAt);
      if(previous)throw new ApplicationHold('uncertain_submission','A submission attempt already exists for this candidate and role. Reconcile it before continuing.');
      const bound=scopedAnswers(job,profile),consentApprovals=Object.fromEntries(Object.entries(job.consentApprovals||{}).filter(([label])=>Object.hasOwn(bound.answers,label)));
      const jobSupportingDocuments={};for(const [questionHash,ref] of Object.entries(job.supportingDocuments||{})){if(!Object.values(bound.answers).some(answer=>answer&&typeof answer==='object'&&answer.documentId===ref.documentId))continue;const document=this.store.get('supportingDocument',ref.documentId);if(!document||document.hash!==ref.hash||document.binding?.questionHash!==questionHash)throw new ApplicationHold('supporting_document_changed','The selected supporting file reference changed. Reattach and review it before continuing.');if(!this.supportingService?.verifyStored)throw new ApplicationHold('supporting_document_unavailable','The supporting document verifier is unavailable. Reopen the app or continue manually.');await this.supportingService.verifyStored(document);guard();jobSupportingDocuments[questionHash]=document;}
      const proposedSupportingArtifacts=Object.entries(jobSupportingDocuments).map(([questionHash,d])=>({documentId:d.id,hash:d.hash,questionHash,mime:d.mime}));
      const intent={id:randomUUID(),kind:'application_attempt',jobId:job.id,identity:job.identity,candidateId:profile.id||'main',campaignId:campaign.id,campaignRevision:campaign.revision,jobRevision:job.revision,packageId:pkg.id,packageHash:pkg.hash,supportingArtifacts:proposedSupportingArtifacts,state:'preparing',startedAt:now()};
      this.store.transaction(()=>{this.store.put('run',intent);this.store.put('job',{...this.job(job.id),state:'applying',activeAttemptId:intent.id,nextAction:'Fill and verify the application form'});});
      const beforeDispatch=({supportingArtifacts=[]}={})=>this.store.transaction(()=>{guard();assertNoPostingReservation(this.store,job);const limitCheck=assessApplicationLimits({job:this.job(job.id),profile,jobs:this.store.list('job'),attempts:this.store.list('run'),userCap:campaign.rules.maxPerEmployer});if(!limitCheck.allowed)throw new ApplicationHold(limitCheck.needsReview?'application_limit_review':limitCheck.confirmed.length?'application_limit_reached':'employer_limit',limitCheck.nextAction,{report:limitCheck});this.store.put('job',{...this.job(job.id),applicationLimitReport:limitCheck});intent.applicationLimitCheck={effectiveCap:limitCheck.effectiveCap,configuredCap:limitCheck.configuredCap,reservationCount:limitCheck.reservationCount,projectedCount:limitCheck.projectedCount,confirmed:limitCheck.confirmed,checkedAt:limitCheck.checkedAt};if(!Array.isArray(supportingArtifacts)||supportingArtifacts.some(item=>!proposedSupportingArtifacts.some(known=>known.documentId===item.documentId&&known.hash===item.hash&&known.questionHash===item.questionHash)))throw fail('The actual supporting uploads do not match the selected reviewed files.');intent.uploadedSupportingArtifacts=supportingArtifacts.map(item=>({documentId:item.documentId,hash:item.hash,questionHash:item.questionHash,mime:item.mime}));if(countReservations(this.store)>campaign.rules.maxApplications)throw new ApplicationHold('campaign_limit','The campaign limit changed while this form was being prepared.');if(countReservations(this.store,job.employer)>campaign.rules.maxPerEmployer)throw new ApplicationHold('employer_limit','Another application used the employer limit while this form was being prepared.');const attempt=this.store.get('run',intent.id);if(attempt.dispatchedAt)throw fail('This submission intent was already dispatched');this.store.put('run',{...attempt,state:'dispatched',applicationLimitCheck:intent.applicationLimitCheck,uploadedSupportingArtifacts:intent.uploadedSupportingArtifacts,dispatchedAt:now()});this.store.event(job.id,'submission_dispatched',{attemptId:intent.id,packageId:pkg.id,applicationLimitCheck:intent.applicationLimitCheck});});
      const result=await this.adapter.submit(job,{...profile,answers:{...profile.answers,...bound.answers},currentProfileAnswers:profile.answers||{},jobAnswers:bound.answers,jobAnswerBindings:bound.bindings,consentApprovals,jobWritingApprovals:job.writingApprovals||{},jobWritingDrafts:job.writingDrafts||{},jobSupportingDocuments},pkg,{guard,beforeDispatch,policy:campaign.rules,intent,sourceProfile:profile});
      if(result?.status==='submitted'&&isMatch(result.evidence,job,profile,intent)&&(!result.evidence.fixture||this.demo)) {
        this.store.transaction(()=>{const current=this.job(job.id),preserve=retainedOutcome(current,job,profile);this.store.put('job',{...current,state:preserve?current.state:'submitted',nextAction:preserve?current.nextAction:this.demo?'Fixture confirmation recorded':'Await employer response',submissionConfirmation:this.demo?'fixture':'employer_confirmed',evidence:[...(current.evidence||[]),result.evidence],submittedAt:current.submittedAt||now()});this.store.put('run',{...this.store.get('run',intent.id),state:'confirmed',finishedAt:now(),evidenceId:result.evidence.id});this.store.event(job.id,'submission_confirmed',{attemptId:intent.id,evidenceId:result.evidence.id,fixture:this.demo});});
        return {submitted:true,fixture:this.demo};
      }
      const current=this.job(job.id);if(retainedOutcome(current,job,profile))return {reconciled:true,state:current.state};
      this.store.put('run',{...this.store.get('run',intent.id),state:'uncertain',finishedAt:now()});return this.hold(this.job(job.id),'uncertain_submission',result?.reason||'No matching employer receipt was found. Investigate before retrying.');
    } catch(error) {return this.handleError(job,error,'application',profile);}
  }
  handleError(job,error,phase,profile=this.store.get('profile','main')) {
    let current=this.job(job.id);if(retainedOutcome(current,job,profile))return {reconciled:true,state:current.state};const attempt=current.activeAttemptId&&this.store.get('run',current.activeAttemptId);
    if(attempt?.dispatchedAt) {this.store.put('run',{...attempt,state:'uncertain',finishedAt:now()});return this.hold(current,'uncertain_submission','Submission dispatch was recorded, but its outcome is uncertain. Investigate before retrying.');}
    // All late failures, including ordinary browser timeouts, lose write ownership.
    // Preserve genuine dispatched uncertainty above, then fence every error side effect.
    if(current.revision!==job.revision||['manual','cancelled'].includes(current.state))return {revoked:true};
    if(error.details?.report&&['application_limit_review','application_limit_reached','employer_limit'].includes(error.code))current=this.store.put('job',{...current,applicationLimitReport:error.details.report});if(error.code==='resume_file_requirements'&&error.details?.document){const document=error.details.document,documents=(current.posting?.documents||[]).filter(d=>!(d.label===document.label&&d.name===document.name&&d.sourceUrl===document.sourceUrl));current=this.store.put('job',{...current,posting:{...current.posting,documents:[...documents,document]}});}
    if(error.code==='action_revoked'||this.stopping) {
      if(current.revision!==job.revision||['manual','cancelled'].includes(current.state))return {revoked:true};
      this.store.put('job',{...current,state:current.packageId?'ready':'imported',nextAction:'Action stopped before submission dispatch',preparationRequested:false});return {revoked:true};
    }
    if(error.code==='model_busy'){if(current.revision!==job.revision||['manual','cancelled'].includes(current.state))return {revoked:true};const campaign=this.campaign(),retry=!['paused','cancelled'].includes(campaign.status);this.store.put('job',{...current,state:'imported',preparationRequested:retry,nextAction:retry?'Waiting for reasoning capacity; preparation will retry automatically':'Reasoning was busy. Resume or explicitly prepare this application when ready'});return {waiting:true,reason:'model_busy'};}
    if(error.code==='needs_you'&&this.store.list('decision').some(d=>(d.jobId===job.id||d.jobIds?.includes(job.id))&&d.state==='open')) {this.store.put('job',{...current,state:'needs_you',nextAction:error.message});return {waiting:true};}
    if(error.code==='account_access'&&!this.accountAdapter) {try{const identity=accountIdentity(job.url,'main');const account=this.store.list('account').find(a=>a.identity===identity);this.store.put('account',{id:account?.id||'account-'+identity.slice(0,20),identity,tenant:tenantKey(job.url),candidateId:'main',state:'needs_access',credentialRef:null,applicationIds:[...new Set([...(account?.applicationIds||[]),job.id])],nextAction:'Employer account access requires protected storage and inbox setup. Continue manually for now.'});}catch{}}
    if(error.hold||['model_unavailable','application_limit_evidence','requirement_evidence','supporting_document_changed','supporting_document_scope','supporting_document_format','needs_you','resume_review','editable_source_needed','resume_missing'].includes(error.code))return this.hold(current,error.code||'preparation_hold',error.message,error.details||{});
    const failures=(current.failures||0)+1;
    this.store.put('job',{...current,state:'failed',failures,lastError:'The '+phase+' step failed before submission. Check the browser/model connection and retry.',nextAction:failures>=3?'Retry limit reached; continue manually':'Resolve the problem, then retry',preparationRequested:false});
    this.store.event(job.id,'step_failed',{phase,failures,errorCode:error.code||'adapter_error'});
    return {failed:true};
  }
  async readiness() {return [await this.adapter.readiness(),this.accountAdapter?await this.accountAdapter.readiness():{id:'accounts',label:'Employer accounts and verification',status:'limited',detail:'Connect an app-owned encrypted vault to use employer accounts.'}];}
}
