import {createHash, randomUUID} from 'node:crypto';
import {normalize, resumePassageContext} from './resumes.mjs';
import {questionFingerprint, writingAnswerHash, writingSourceUrl, classifyWritingPolicy} from './writing-policy.mjs';

const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const fail=(code,message,details={})=>Object.assign(new Error(message),{code,status:409,details});
const canonical=value=>{
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
};
const fingerprint=value=>digest(canonical(value));
const words=text=>text.trim()?text.trim().split(/\s+/u).length:0;
const terms=text=>new Set(String(text).toLowerCase().match(/[\p{L}\p{N}+#.]{3,}/gu)||[]);
const generic=new Set(['projects','experience','work experience','professional experience','education','skills','technical skills','summary','research','research experience','publications']);
const projectName=context=>String(context||'').split('|').at(-1).replace(/^paragraph:/,'').replace(/^#+\s*/,'').trim();
const projectKey=context=>{
  const name=projectName(context).toLowerCase();
  return name.length>=4&&!generic.has(name)?normalize(String(context)).toLowerCase():null;
};
const bindingFields=['jobId','questionHash','packageId','postingHash','profileRevision'];
function reviewedBinding(value,actual){
  if(value===undefined)return undefined;
  if(!value||typeof value!=='object'||Array.isArray(value)||Reflect.ownKeys(value).length!==bindingFields.length||bindingFields.some(key=>!Object.hasOwn(value,key)||typeof value[key]!=='string'||!value[key]||value[key].length>1000))throw Object.assign(fail('writing_binding','Provide the complete exact reviewed writing context, without extra fields.'),{status:400});
  if(bindingFields.some(key=>value[key]!==actual[key]))throw fail('writing_stale','The reviewed job, question, posting, resume package or profile changed. Review the current context before requesting a draft.');
  return Object.fromEntries(bindingFields.map(key=>[key,value[key]]));
}

function limitsFor(question){
  const integer=(value,label)=>{
    if(value===undefined||value===null||value===-1)return null;
    if(!Number.isInteger(value)||value<0||value>100000)throw fail('writing_metadata',`The employer ${label} metadata is invalid.`);
    return value;
  };
  const minLength=integer(question.minLength,'minimum length'),maxLength=integer(question.maxLength,'maximum length');
  const maxWords=[integer(question.wordLimit,'word limit'),integer(question.maxWords,'word limit')].filter(value=>value!==null);
  const minWords=[integer(question.minWords,'minimum word count')].filter(value=>value!==null);
  const label=question.label;
  for(const match of label.matchAll(/\b(?:maximum|max|up to|at most|no more than)\s*(\d{1,5})\s+words?\b/gi))maxWords.push(Number(match[1]));
  for(const match of label.matchAll(/\bword limit\s*[:=]?\s*(\d{1,5})\b/gi))maxWords.push(Number(match[1]));
  for(const match of label.matchAll(/\b(\d{1,5})[- ]words?\s*(?:maximum|max|limit|or fewer|or less)\b/gi))maxWords.push(Number(match[1]));
  for(const match of label.matchAll(/\b(?:in|within)\s+(\d{1,5})\s+words?\b/gi))maxWords.push(Number(match[1]));
  for(const match of label.matchAll(/\bbetween\s+(\d{1,5})\s+and\s+(\d{1,5})\s+words?\b/gi)){minWords.push(Number(match[1]));maxWords.push(Number(match[2]));}
  const wordLimit=maxWords.length?Math.min(...maxWords):null,minWordLimit=minWords.length?Math.max(...minWords):null;
  if(minLength!==null&&maxLength!==null&&minLength>maxLength||minWordLimit!==null&&wordLimit!==null&&minWordLimit>wordLimit)throw fail('writing_metadata','The employer writing limits conflict. Review the actual question.');
  return {minLength,maxLength,wordLimit,minWordLimit};
}

const numberWords=new Map(['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety','hundred','thousand','million','billion'].map(word=>[word,word]));
const units=new Map(Object.entries({percent:'percent',percentage:'percent',ms:'millisecond',milliseconds:'millisecond',millisecond:'millisecond',seconds:'second',second:'second',minutes:'minute',minute:'minute',hours:'hour',hour:'hour',days:'day',day:'day',weeks:'week',week:'week',months:'month',month:'month',years:'year',year:'year',cases:'case',case:'case',tests:'case',test:'case',samples:'sample',sample:'sample',trials:'trial',trial:'trial',users:'user',user:'user',people:'person',persons:'person',participants:'person',students:'student',clients:'client',customers:'customer',projects:'project',project:'project',rows:'row',records:'record',requests:'request',sensors:'sensor',sensor:'sensor',devices:'device',device:'device',models:'model',model:'model',thousand:'thousand',million:'million',billion:'billion',volts:'volt',volt:'volt',v:'volt',amps:'amp',amp:'amp',amperes:'amp',watts:'watt',watt:'watt',w:'watt',hertz:'hertz',hz:'hertz',megabytes:'megabyte',mb:'megabyte',gigabytes:'gigabyte',gb:'gigabyte',millimeters:'millimeter',mm:'millimeter',centimeters:'centimeter',cm:'centimeter',kilometers:'kilometer',km:'kilometer'}));
function numericTokens(text){
  const tokens=[];
  for(const match of text.matchAll(/\d+(?:[.,]\d+)*(?:\s*%)?/gu)){
    const value=match[0].replace(/\s|%/g,'');tokens.push('number:'+value);
    const tail=text.slice(match.index+match[0].length).split(/[.!?;\n\d]/u)[0];
    const unit=/%/.test(match[0])?'percent':(tail.toLowerCase().match(/[a-z]+/g)||[]).slice(0,4).map(word=>units.get(word)).find(Boolean);
    if(unit)tokens.push('quantity:'+value+':'+unit);
  }
  for(const token of text.toLowerCase().match(/[a-z]+/g)||[])if(numberWords.has(token))tokens.push('word:'+token);
  return tokens;
}
const qualifiers=[[/\bprototyp(?:e|es|ing)\b/i,/\bprototyp(?:e|es|ing)\b/i,'prototype'],[/\bsimulat(?:ed|ion|ions|ing)\b/i,/\bsimulat(?:ed|ion|ions|ing)\b/i,'simulation'],[/\bacademic\b/i,/\bacademic\b/i,'academic'],[/\bteam\b/i,/\bteam\b/i,'team'],[/\b(?:assisted|helped|supported)\b/i,/\b(?:assisted|helped|supported)\b/i,'assisted contribution']];

function validateOutput(output,snapshot){
  if(!output||!Array.isArray(output.sentences)||output.sentences.length>40||!Array.isArray(output.missingFacts)||output.missingFacts.length>12||typeof output.explanation!=='string'||output.explanation.length>2000)throw fail('writing_invalid','The writing response did not match the bounded draft format.');
  if(output.missingFacts.some(text=>typeof text!=='string'||!text.trim()||text.length>500))throw fail('writing_invalid','The writing response contains invalid missing-fact questions.');
  if(!output.sentences.length&&!output.missingFacts.length)throw fail('writing_invalid','The model returned neither a draft nor missing facts.');
  const catalog=new Map(snapshot.catalog.map(source=>[source.id,source]));
  const claims=output.sentences.map(sentence=>{
    if(!sentence||typeof sentence.text!=='string'||!sentence.text.trim()||sentence.text.length>1800||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(sentence.text)||!Array.isArray(sentence.sourceIds)||!sentence.sourceIds.length||sentence.sourceIds.length>8||sentence.sourceIds.some(id=>typeof id!=='string'||!catalog.has(id)))throw fail('writing_grounding','Each draft sentence needs valid, visible source evidence.');
    const sourceIds=[...new Set(sentence.sourceIds)],sources=sourceIds.map(id=>catalog.get(id));
    const contexts=new Set(sources.map(source=>source.projectKey).filter(Boolean));
    if(contexts.size>1)throw fail('writing_grounding','A sentence combines different project or experience contexts. Keep each source attribution separate.');
    const sourceText=sources.flatMap(source=>[source.text,...(source.supportingContext||[])]).join('\n'),knownNumbers=new Set(numericTokens(sourceText));
    const actualNumbers=numericTokens(sentence.text);
    if(actualNumbers.some(token=>!knownNumbers.has(token)))throw fail('writing_grounding','A draft sentence introduces a number or metric unit absent from its cited sources.');
    for(const number of actualNumbers.filter(token=>token.startsWith('number:'))){const prefix='quantity:'+number.slice(7)+':';if([...knownNumbers].some(token=>token.startsWith(prefix))&&!actualNumbers.some(token=>token.startsWith(prefix)))throw fail('writing_grounding','A draft sentence loses the unit of a cited metric.');}
    for(const [sourcePattern,answerPattern,label]of qualifiers)if(sourcePattern.test(sourceText)&&!answerPattern.test(sentence.text))throw fail('writing_grounding',`A draft sentence loses the source ${label} qualifier.`);
    if(/\b(?:led|lead|owned|launched|deployed|production)\b/i.test(sentence.text)&&[...sentence.text.matchAll(/\b(?:led|lead|owned|launched|deployed|production)\b/gi)].some(match=>!new RegExp(`\\b${match[0]}\\b`,'i').test(sourceText)))throw fail('writing_grounding','A draft sentence adds unsupported ownership or production maturity.');
    if(/\bI\s+(?:built|created|developed|led|designed|evaluated|tested|implemented|measured|worked|researched)\b/i.test(sentence.text)&&!sources.some(source=>['resume_fact','candidate_note'].includes(source.kind)))throw fail('writing_grounding','Employer requirements and candidate identity do not establish a candidate accomplishment.');
    if(/\b(?:citizen(?:ship)?|visa|sponsor(?:ship|ed|ing)?|work authori[sz]ation|authori[sz]ed to work|security clearance|disabilit(?:y|ies)|veteran|ethnicity|gender|pregnan(?:t|cy)|marital status|sexual orientation)\b/i.test(sentence.text)){
      const exact=normalize(sentence.text).replace(/^[-*•]\s*/,'');
      if(!sources.some(source=>['resume_fact','candidate_note'].includes(source.kind)&&source.text.split(/\n+|(?<=[.!?])\s+/u).some(line=>normalize(line).replace(/^[-*•]\s*/,'')===exact)))throw fail('writing_grounding','Sensitive status and eligibility cannot be inferred or paraphrased. Use the candidate’s exact supplied wording or answer manually.');
    }
    for(const name of snapshot.contextNames.values())if(normalize(sentence.text).toLowerCase().includes(name.toLowerCase())&&![...contexts].some(key=>snapshot.contextNames.get(key)?.toLowerCase()===name.toLowerCase()))throw fail('writing_grounding','A draft sentence attributes its evidence to another known project or experience.');
    return {text:sentence.text,sourceIds,reviewRequired:true};
  });
  const allContexts=new Set(claims.flatMap(claim=>claim.sourceIds.map(id=>catalog.get(id).projectKey).filter(Boolean)));
  if(allContexts.size>1)for(const claim of claims)for(const key of new Set(claim.sourceIds.map(id=>catalog.get(id).projectKey).filter(Boolean)))if(!normalize(claim.text).toLowerCase().includes(snapshot.contextNames.get(key).toLowerCase()))throw fail('writing_grounding','A draft using multiple projects must name the project in each corresponding sentence.');
  const text=claims.map(claim=>claim.text).join(' '),actualLength=text.length,actualWords=words(text),limits=snapshot.limits;
  if(actualLength>12000||limits.maxLength!==null&&actualLength>limits.maxLength||text&&limits.minLength!==null&&actualLength<limits.minLength||limits.wordLimit!==null&&actualWords>limits.wordLimit||text&&limits.minWordLimit!==null&&actualWords<limits.minWordLimit)throw fail('writing_length','The draft does not meet the employer’s length limits. Revise it rather than silently trimming facts.',{...limits,actualLength,actualWords});
  const used=new Set(claims.flatMap(claim=>claim.sourceIds));
  return {text,claims,sourceEvidence:snapshot.catalog.filter(source=>used.has(source.id)),missingFacts:output.missingFacts,explanation:output.explanation};
}

export class WritingService {
  constructor({store,model}){this.store=store;this.model=model;this.closed=false;this.epoch=0;this.pending=new Map();}
  assertOpen(){if(this.closed)throw fail('writing_closed','Writing drafting stopped before the result could be retained.');}
  snapshot({decisionId,questionLabel,allowedAssistance,notes='',expectedBinding}){
    this.assertOpen();
    if(allowedAssistance!==true)throw fail('writing_permission_required','Confirm that assistance is permitted for this exact employer question before drafting.');
    if(typeof notes!=='string'||notes.length>2000)throw fail('writing_notes','Candidate notes must be text of at most 2,000 characters.');
    if(typeof decisionId!=='string'||typeof questionLabel!=='string'||!questionLabel||questionLabel.length>2000)throw fail('writing_question','Choose one actual employer writing question.');
    const decision=this.store.get('decision',decisionId),job=decision&&this.store.get('job',decision.jobId);
    if(!decision||decision.state!=='open'||decision.code!=='form_questions'||!job||job.state!=='needs_you')throw fail('writing_stale','This employer question is no longer waiting for an answer.');
    const questions=(decision.details?.questions||[]).filter(question=>question.label===questionLabel&&['writing','writing_review'].includes(question.kind));
    if(questions.length!==1)throw fail('writing_question','The selected field is missing or ambiguous, or is not a writing question.');
    const question=questions[0],questionHash=questionFingerprint(question),limits=limitsFor(question);
    const profile=this.store.get('profile','main'),pkg=this.store.get('package',job.packageId);
    if(typeof profile?.fullName!=='string'||!profile.fullName.trim()||profile.fullName.length>200||typeof profile.email!=='string'||!/^\S+@\S+\.\S+$/.test(profile.email)||profile.email.length>254||!profile.updatedAt||!pkg?.verified||pkg.jobId!==job.id||typeof pkg.hash!=='string'||!pkg.hash||pkg.profileRevision!==profile.updatedAt||!job.posting?.sourceHash||typeof job.posting.text!=='string'||!job.posting.text.trim())throw fail('writing_context','Confirm the current profile, actual posting and verified resume package before drafting.');
    const expected=reviewedBinding(expectedBinding,{jobId:job.id,questionHash,packageId:pkg.id,postingHash:job.posting.sourceHash,profileRevision:profile.updatedAt});
    const policy=classifyWritingPolicy(job.posting.text,{questionText:question.label});
    const nativePolicy=question.writingPolicy,formQuotes=(Array.isArray(question.policyQuotes)?question.policyQuotes:[]).filter(item=>item&&typeof item.quote==='string'&&item.quote.trim());
    const nativeBlocked=nativePolicy?.aiWritingProhibited===true||nativePolicy?.automationProhibited===true||nativePolicy?.assessment===true;
    if(nativeBlocked&&!formQuotes.length)throw fail('writing_metadata','The employer form records a writing restriction without its exact rule text. Continue manually or capture the current form again.');
    const quotedPolicy=classifyWritingPolicy(formQuotes.map(item=>item.quote).join('\n'),{questionText:question.label});
    if(nativeBlocked||policy.aiWritingProhibited||policy.automationProhibited||policy.assessment||quotedPolicy.aiWritingProhibited||quotedPolicy.automationProhibited||quotedPolicy.assessment)throw fail('writing_not_permitted','The actual employer text requires independent work or prohibits this assistance. Continue without an AI draft.',{quotes:[...policy.quotes,...formQuotes],policy,formPolicy:nativePolicy||quotedPolicy});
    const facts=this.store.list('fact'),resumes=this.store.list('resume'),byResume=new Map(resumes.map(resume=>[resume.id,resume]));
    if((pkg.sources||[]).some(source=>source.resumeId&&source.hash&&byResume.get(source.resumeId)?.hash!==source.hash))throw fail('writing_context','The verified package refers to an older resume source. Prepare the current source before drafting.');
    const questionTerms=terms(question.label+' '+notes+' '+job.title),postingTerms=terms(job.posting.text.slice(0,24000));
    const candidates=[],seen=new Set(),contextNames=new Map();
    for(const fact of facts){
      if(fact.conflict||fact.suppressed||typeof fact.text!=='string'||!fact.text.trim()||fact.text.length>1800)continue;
      for(const source of fact.sources||[]){
        const resume=byResume.get(source.resumeId),quote=source.quote,context=source.context,key=projectName(context).toLowerCase()===profile.fullName.toLowerCase()?null:projectKey(context);
        if(!resume?.hash||typeof resume.text!=='string'||typeof quote!=='string'||normalize(quote)!==normalize(fact.text)||!context||!key&&projectName(context).toLowerCase()!==profile.fullName.toLowerCase()||resume.text.split('\n').filter(line=>normalize(line)===normalize(quote)).length!==1||resumePassageContext(resume,quote)!==context)continue;
        const identity=fact.id+'|'+key;if(seen.has(identity))continue;seen.add(identity);
        const sourceTerms=terms(fact.text+' '+context),score=[...sourceTerms].reduce((sum,term)=>sum+(questionTerms.has(term)?4:0)+(postingTerms.has(term)?1:0),0)+(resume.id===pkg.resumeId?10:0);
        const supportingContext=resume.structureContexts?.scopeEvidence?.[context]||[];
        if(supportingContext.join('\n').length>4000)continue;
        const evidence={id:'source-'+digest(identity+'|'+resume.id).slice(0,24),kind:'resume_fact',text:quote,context,contextLabel:resume.structureContexts?.labels?.[context]||projectName(context),supportingContext,resumeId:resume.id,resumeName:resume.name,factId:fact.id,sourceHash:resume.hash,projectKey:key};
        candidates.push({evidence,score});if(key)contextNames.set(key,projectName(context));
      }
    }
    const catalog=[{id:'profile-name-'+digest(profile.fullName).slice(0,16),kind:'profile',text:profile.fullName,context:'Confirmed candidate name',projectKey:null}];
    if(notes.trim())catalog.push({id:'candidate-notes-'+digest(notes).slice(0,16),kind:'candidate_note',text:notes,context:'Candidate-supplied choices and notes; factual review required',projectKey:null});
    let size=catalog.reduce((sum,source)=>sum+source.text.length,0);
    const postingQuotes=job.posting.text.split(/\n+|(?<=[.!?])\s+/u).map(text=>text.trim()).filter(text=>text.length>=12&&text.length<=1800).map(text=>({text,score:[...terms(text)].filter(term=>questionTerms.has(term)).length})).sort((a,b)=>b.score-a.score).slice(0,6);
    for(const {text}of postingQuotes){if(size+text.length>8000)continue;catalog.push({id:'posting-'+digest(job.posting.sourceHash+'|'+text).slice(0,24),kind:'employer_posting',text,context:'Employer posting; not candidate experience',sourceHash:job.posting.sourceHash,sourceUrl:writingSourceUrl(job.posting.sourceUrl||job.url||question.sourceUrl),projectKey:null});size+=text.length;}
    for(const {evidence}of candidates.sort((a,b)=>b.score-a.score||a.evidence.id.localeCompare(b.evidence.id))){const length=evidence.text.length+evidence.supportingContext.join('\n').length+(evidence.contextLabel?.length||0);if(catalog.length>=48||size+length>24000)continue;catalog.push(evidence);size+=length;}
    // Own draft metadata may change without changing job authority. Every other
    // job byte, and all current source records, must still match after the model.
    const {writingDrafts,updatedAt,...authority}=job;
    const stateFingerprint=fingerprint({decision,job:authority,profile,pkg,facts,resumes});
    const requestHash=fingerprint({decisionId,questionLabel,questionHash,notes,allowedAssistance,stateFingerprint});
    return {decision,job,question,questionHash,profile,pkg,notes,limits,catalog,contextNames,stateFingerprint,requestHash,expectedBinding:expected,epoch:this.epoch};
  }
  current(snapshot){
    this.assertOpen();if(snapshot.epoch!==this.epoch)throw fail('writing_stale','The writing request was revoked.');
    const fresh=this.snapshot({decisionId:snapshot.decision.id,questionLabel:snapshot.question.label,allowedAssistance:true,notes:snapshot.notes,expectedBinding:snapshot.expectedBinding});
    if(fresh.stateFingerprint!==snapshot.stateFingerprint||fresh.requestHash!==snapshot.requestHash)throw fail('writing_stale','The job, employer question or source evidence changed. Request a fresh draft.');
    return fresh;
  }
  async draft(input){
    const snapshot=this.snapshot(input),key=snapshot.decision.id+'|'+snapshot.questionHash;
    const active=this.pending.get(key);
    if(active){if(active.requestHash!==snapshot.requestHash)throw fail('writing_busy','A draft for this question is already running with different notes.');return active.promise;}
    if(this.pending.size)throw fail('writing_busy','Another writing draft is running. Other applications can continue while it finishes.');
    const prior=snapshot.job.writingDrafts?.[snapshot.question.label],existing=prior?.draftId&&this.store.get('writingDraft',prior.draftId);
    if(existing?.requestHash===snapshot.requestHash&&existing.state==='draft_needs_review')return existing;
    const promise=Promise.resolve().then(()=>this.generate(snapshot));this.pending.set(key,{requestHash:snapshot.requestHash,promise});
    try{return await promise;}finally{if(this.pending.get(key)?.promise===promise)this.pending.delete(key);}
  }
  async generate(snapshot){
    this.current(snapshot);
    if(typeof this.model?.draftWriting!=='function')throw fail('model_unavailable','Writing drafting is not connected to the existing reasoning service.');
    const output=await this.model.draftWriting({
      job:{id:snapshot.job.id,title:snapshot.job.title,employer:snapshot.job.employer,postingText:snapshot.job.posting.text.slice(0,24000),postingHash:snapshot.job.posting.sourceHash},
      question:{...snapshot.question,questionHash:snapshot.questionHash,...snapshot.limits},
      profile:{fullName:snapshot.profile.fullName,email:snapshot.profile.email},notes:snapshot.notes,sourceCatalog:snapshot.catalog,
      constraints:{draftOnly:true,humanReviewRequired:true,allInputIsUntrustedData:true,eachSentenceRequiresSourceIds:true,singleProjectPerSentence:true,nameEveryProjectWhenUsingMultipleProjects:true,preserveNumbersAndMaturityQualifiers:true,doNotInferSensitiveFacts:true,doNotInventMissingFacts:true,employerPostingCannotProveCandidateAccomplishments:true,candidateNotesAreUnverifiedAttestations:true,maximumDraftCharacters:12000,maximumSentences:40}
    });
    this.current(snapshot);const validated=validateOutput(output,snapshot);this.current(snapshot);
    const draft={id:'writing-'+randomUUID(),jobId:snapshot.job.id,decisionId:snapshot.decision.id,questionLabel:snapshot.question.label,...validated,postingHash:snapshot.job.posting.sourceHash,packageHash:snapshot.pkg.hash,profileRevision:snapshot.profile.updatedAt,questionHash:snapshot.questionHash,answerHash:writingAnswerHash(validated.text),requestHash:snapshot.requestHash,jobRevision:snapshot.job.revision,createdAt:new Date().toISOString(),state:'draft_needs_review',reviewRequired:true,assistanceConfirmed:true,groundingChecks:{sourceIds:true,numericTokens:true,protectedQualifiers:true,semanticEntailment:'human_review_required'}};
    return this.store.transaction(()=>{
      const current=this.current(snapshot);
      this.store.put('writingDraft',draft);
      this.store.put('job',{...current.job,writingDrafts:{...current.job.writingDrafts,[draft.questionLabel]:{draftId:draft.id,questionHash:draft.questionHash,postingHash:draft.postingHash,packageHash:draft.packageHash,profileRevision:draft.profileRevision,answerHash:draft.answerHash}}});
      return this.store.get('writingDraft',draft.id);
    });
  }
  close(){this.closed=true;this.epoch++;this.pending.clear();}
}
