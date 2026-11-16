import {createHash} from 'node:crypto';
import {portalFor,postingIdentity} from './adapters.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
const clean=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim();
export const applicationEmployerKey=value=>clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const reservedStates=new Set(['applying','uncertain','submitted','interview','assessment','rejected','offer','manual']);
export function isApplicationReservation(job,attempts=[]){return reservedStates.has(job.state)||Boolean(job.submittedAt||job.submissionConfirmation||job.evidence?.some(e=>['employer_confirmation','candidate_attested_receipt','matched_email_receipt'].includes(e.type)))||attempts.some(run=>run.dispatchedAt&&!run.retiredAt&&(run.jobId===job.id||job.identity&&run.identity===job.identity));}
function roleKey(raw){const portal=portalFor(raw);if(portal!=='unsupported')return postingIdentity(raw,portal);const url=new URL(raw);if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error();url.hash='';url.pathname=url.pathname.replace(/\/$/,'');url.searchParams.sort();return url.toString();}
function sourceBound(source){try{return Boolean(source.posting?.sourceHash&&source.posting?.sourceUrl&&roleKey(source.url)===roleKey(source.posting.sourceUrl)&&clean(source.posting.title)===clean(source.title)&&applicationEmployerKey(source.posting.employer)===applicationEmployerKey(source.employer));}catch{return false;}}
const number='(?:one|two|three|four|five|[0-9]{1,3})',unit='(?:applications?|(?:internship|job) applications?|roles?|positions?|internships?)';
const amount=String.raw`(?<amount>${number})(?:\s*\((?<parenthetical>${number})\))?\s+(?:(?:different|distinct|separate|total|preferred)\s+)?(?<unit>${unit})\b`;
const countPatterns=[new RegExp(String.raw`\b(?:maximum(?: of)?|at most|no more than|only|up to|not\s+(?:submit|make|send)\s+more than|limit(?:ed)? (?:of|to))\s+${amount}`,'gi'),new RegExp(String.raw`\blimits?\s+(?:candidates?|applicants?|you)\s+to\s+${amount}`,'gi'),new RegExp(String.raw`\b${amount}\s+(?:per (?:candidate|person|applicant)\s+)?(?:only|maximum)\b`,'gi'),new RegExp(String.raw`\b(?<unit>applications?)\s+limits?\s*:?\s*(?<amount>${number})\b`,'gi')];
const words={one:1,two:2,three:3,four:4,five:5};
const asNumber=value=>Object.hasOwn(words,value.toLowerCase())?words[value.toLowerCase()]:Number(value);
const applicant=/\b(?:apply|applying|submit|submitting)\b|\bapplications?\s+per\s+(?:candidate|person|applicant)\b|\blimits?\s+(?:candidates?|applicants?|you)\b|\bapplications? limits?\b|\bmaximum (?:number of )?applications?\b/i;
const restrictive=/\b(?:maximum|at most|no more than|only|up to|limited|limits?|more than)\b/i;
const objects=/\b(?:applications?|roles?|positions?|internships?)\b/i;
function declarationReason(quote,source,current,cap,scopeName,now){
 if(!sourceBound(source))return 'posting_identity_or_source_unverified';
 if(!Number.isInteger(cap)||cap<1||cap>500)return 'limit_number_unclear';
 if(!scopeName)return 'employer_wide_scope_not_explicit';
 if(/\b(?:this|same|each|per|single|given)\s+(?:role|position|internship|requisition|opening)\b/i.test(quote))return 'individual_role_scope_requires_review';
 if(/\b(?:programmes?|programs?|cycles?|seasons?|semesters?|terms?|recruiting rounds?|hiring rounds?|calendar years?|fiscal years?|academic years?)\b|\b(?:per|each|every|current|this|next|same)\s+year\b|\b20\d{2}\b/i.test(quote))return 'program_or_hiring_period_scope_requires_review';
 if(/\b(?:priorit\w*|prefer\w*|recommend\w*|ranking|ranked)\b|\b(?:first|second|top)\s+choice\b/i.test(quote))return 'priority_or_preference_is_not_a_confirmed_employer_cap';
 if(/\b(?:active|simultaneous|concurrent|withdraw|withdrawn|at (?:any|one) (?:given )?time|unless|except|excluding|depending|however|otherwise)\b/i.test(quote))return 'conditional_or_active_application_scope_requires_review';
 if(/\b(?:footer|sidebar|related programs?|other employers?|other companies|another company|unlike|elsewhere|example policy|for example|hypothetical)\b/i.test(quote))return 'secondary_or_example_scope_requires_review';
 if(source.campaignId&&current.campaignId&&source.campaignId!==current.campaignId)return 'different_campaign_scope_requires_review';
 if(source.id!==current.id&&source.posting.deadline&&!source.posting.deadlineUncertain&&Number.isFinite(Date.parse(source.posting.deadline))&&Date.parse(source.posting.deadline)<=now)return 'historical_posting_scope_requires_review';
 return null;
}
function declarations(source,current,candidateId,now){
 const text=String(source.posting?.text||'').slice(0,100000);if(!text)return [];
 const employerKey=applicationEmployerKey(current.employer),result=[];
 const clauses=text.split(/\n+|(?<!\bInc\.)(?<!\bLtd\.)(?<!\bCo\.)(?<=[.!?])\s+/i).slice(0,2000);
 for(const raw of clauses){const quote=raw.trim();if(!quote)continue;const normalized=clean(quote);if(/\b(?:no|without|not subject to an?)\s+(?:application )?limits?\b|\bunlimited applications?\b/i.test(normalized)&&!/(?:only|at most|no more than|maximum)\s+(?:one|two|three|four|five|[0-9]+)/i.test(normalized))continue;if(!applicant.test(normalized)||!restrictive.test(normalized)||!objects.test(normalized))continue;const matches=[];for(const expression of countPatterns){expression.lastIndex=0;for(const match of normalized.matchAll(expression)){const cap=asNumber(match.groups.amount),before=normalized.slice(Math.max(0,match.index-100),match.index).split(/[;:]/).at(-1),bound=/\b(?:apply|applying|submit|submitting)\b|\blimits?\s+(?:candidates?|applicants?|you)\b|\bapplications? limits?\b|\bper (?:candidate|person|applicant)\b/i.test(before+' '+match[0])||/\bper (?:candidate|person|applicant)\b/i.test(normalized.slice(match.index+match[0].length,match.index+match[0].length+40));matches.push({cap,parenthetical:match.groups.parenthetical?asNumber(match.groups.parenthetical):null,unit:match.groups.unit,bound});}}
  if(matches.length&&!matches.some(match=>match.bound)&&/\b(?:offer|offers|offering|hiring|openings|vacancies|positions available)\b/i.test(normalized))continue;const relevant=matches.filter(match=>match.bound);if(!matches.length&&!/\b(?:maximum(?: of)?|at most|no more than|only|up to|not (?:submit|make|send) more than|limit(?:ed)? (?:of|to))\s+(?:[a-z]+|[0-9]+(?:[-–][0-9]+)?)(?:\s+(?:different|distinct|separate|total|preferred))?\s+(?:applications?|roles?|positions?|internships?)\b|\bapplications? limits?\b/i.test(normalized))continue;const amounts=[...new Set((relevant.length?relevant:matches).map(match=>match.cap))];let cap=amounts.length===1?amounts[0]:null;
  const namePresent=employerKey.length>=3&&(' '+applicationEmployerKey(normalized)+' ').includes(' '+employerKey+' ');
  let reason=declarationReason(normalized,source,current,cap,namePresent,now);if(matches.length&&!relevant.length)reason='count_not_bound_to_an_applicant_application_action';
  if(matches.some(match=>match.parenthetical!==null&&match.parenthetical!==match.cap)||amounts.length>1)reason='conflicting_numbers_or_multiple_scopes_require_review';
  if(quote.length>2000)reason='long_clause_scope_requires_review';
  const evidenceQuote=quote.length<=2000?quote:quote.slice(Math.max(0,quote.toLowerCase().search(/maximum|at most|no more than|only|up to|limit|more than/)-200)).slice(0,2000);
  result.push({id:'application-limit-'+digest(`${source.id}\0${source.posting?.sourceHash||''}\0${evidenceQuote}\0${cap}`).slice(0,24),cap,scope:reason?'unconfirmed':'employer',reason,quote:evidenceQuote,units:[...new Set(matches.map(match=>match.unit))],sourceJobId:source.id,sourceJobIdentity:source.identity||source.id,sourceUrl:source.posting?.sourceUrl||source.url,postingHash:source.posting?.sourceHash||null,observedAt:source.posting?.observedAt||null,employerKey,candidateId});
 }
 return result;
}
export function assessApplicationLimits({job,profile,jobs=[],attempts=[],userCap,now=Date.now()}={}){
 if(!Number.isInteger(userCap)||userCap<1||userCap>500)throw Object.assign(new Error('The configured employer application cap must be a whole number from 1 to 500.'),{code:'application_limit_evidence',status:400});
 const candidateId=profile?.id,employerKey=applicationEmployerKey(job?.employer);if(!job?.id||!candidateId||!employerKey)throw Object.assign(new Error('Application limits require a verified candidate and employer.'),{code:'application_limit_evidence',status:409});
 const records=new Map(jobs.map(record=>[record.id,record]));records.set(job.id,job);const sameEmployer=[...records.values()].filter(record=>(!record.candidateId||record.candidateId===candidateId)&&applicationEmployerKey(record.employer)===employerKey);
 const all=sameEmployer.flatMap(source=>declarations(source,job,candidateId,Number(now))),confirmed=all.filter(entry=>!entry.reason),ambiguous=all.filter(entry=>entry.reason);
 const caps=[...new Set(confirmed.map(entry=>entry.cap))];if(caps.length>1)for(const entry of confirmed)ambiguous.push({...entry,id:entry.id+'-conflict',scope:'unconfirmed',reason:'conflicting_employer_wide_declarations_require_review'});
 const effectiveCap=Math.min(userCap,...confirmed.map(entry=>entry.cap));const reserved=new Map();for(const record of sameEmployer){if(record.id===job.id||!isApplicationReservation(record,attempts))continue;const identity=record.identity||record.id;if(!reserved.has(identity))reserved.set(identity,{jobId:record.id,jobIdentity:identity,state:record.state,submittedAt:record.submittedAt||null,confirmation:record.submissionConfirmation||null});}
 const reservations=[...reserved.values()],projectedCount=reservations.length+1,needsReview=ambiguous.length>0;
 return {configuredCap:userCap,effectiveCap,confirmed,ambiguous,reservations,reservationCount:reservations.length,projectedCount,allowed:!needsReview&&projectedCount<=effectiveCap,needsReview,employerKey,candidateId,currentJobId:job.id,postingHash:job.posting?.sourceHash||null,checkedAt:new Date(Number(now)).toISOString(),coverage:'actual_stored_selected_postings_and_durable_reservations',nextAction:needsReview?'Review the exact employer application-limit scope or continue manually. Other employers can continue.':projectedCount>effectiveCap?'The employer application cap is reserved or reached. Reconcile existing applications before retrying; keep this job visible.':'Within the configured and observed employer caps; recheck immediately before dispatch.'};
}
