import { spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { tenantKey } from './accounts.mjs';
import { validateDestination } from './adapters.mjs';

const stamp=()=>new Date().toISOString();
const digest=s=>createHash('sha256').update(s).digest('hex');
const err=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const normalize=s=>String(s||'').normalize('NFKC').replace(/\s+/g,' ').trim();
const emailPattern=/^[A-Za-z0-9][A-Za-z0-9._%+\-]{0,127}@[A-Za-z0-9](?:[A-Za-z0-9.\-]{0,190}[A-Za-z0-9])?\.[A-Za-z]{2,63}$/;
function email(value){const e=String(value||'').trim().toLowerCase();if(!emailPattern.test(e))throw err('INBOX_CONFIG','Use a complete email address without display names or query syntax.',400);return e;}
const quote=s=>'"'+normalize(s).replace(/\\/g,'\\\\').replace(/"/g,'\\"').slice(0,180)+'"';
const unique=values=>[...new Set(values)];
const METHODS={profile:['gmail','users','getProfile'],list:['gmail','users','messages','list'],get:['gmail','users','messages','get']};
const CONNECTION='inbox';
const activeVerification=r=>Boolean(r&&['pending','waiting'].includes(r.state));

export function resolveGws(command=process.env.HUB_GWS_BIN){
 const candidates=command?[command]:[path.join(homedir(),'Library','Application Support','Automation Hub','runtime','gws','0.22.5','gws'),...String(process.env.PATH||'').split(path.delimiter).filter(Boolean).map(p=>path.join(p,'gws'))];
 return candidates.find(p=>path.isAbsolute(p)&&existsSync(p))||null;
}
function validateRead(method,params){
 if(!Object.hasOwn(METHODS,method)||params?.userId!=='me')throw err('INBOX_METHOD','Only the selected mailbox read methods are supported.',400);
 const permitted=method==='profile'?['userId']:method==='list'?['userId','q','maxResults','pageToken','includeSpamTrash']:['userId','id','format'];
 if(Object.keys(params).some(k=>!permitted.includes(k)))throw err('INBOX_METHOD','Unsupported Gmail read parameter.',400);
 if(method==='list'&&(!Number.isInteger(params.maxResults)||params.maxResults<1||params.maxResults>50||typeof params.q!=='string'||params.q.length>3000||params.includeSpamTrash!==false||params.pageToken&&(!/^[A-Za-z0-9_\-+=/.]{1,2048}$/.test(params.pageToken))))throw err('INBOX_METHOD','Mailbox search exceeds the supported bounds.',400);
 if(method==='get'&&(!/^[A-Za-z0-9_-]{1,200}$/.test(params.id||'')||params.format!=='full'))throw err('INBOX_METHOD','Only bounded full message reads are supported.',400);
}

// The command is fixed by the server operator, never by a page, email or browser input.
// Credentials stay with gws native authentication. No auth/export/write method exists here.
export function createGwsRunner({command,directory,timeoutMs=15000,maxBytes=2*1024*1024}={}){
 return async(method,params)=>{
  validateRead(method,params);const executable=resolveGws(command);if(!executable)throw err('INBOX_CLI_MISSING','The pinned Gmail CLI is missing. Follow the read-only connection setup.');
  await access(executable,constants.X_OK).catch(()=>{throw err('INBOX_CLI_MISSING','The configured Gmail CLI is not executable.');});
  const nativeConfig=path.join(directory||path.join(homedir(),'Library','Application Support','Automation Hub'),'connections','gmail-gws');await mkdir(nativeConfig,{recursive:true,mode:0o700});
  const cwd=await mkdtemp(path.join(tmpdir(),'hub-gmail-read-'));await writeFile(path.join(cwd,'.env'),'',{mode:0o600});
  const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','TMPDIR','LANG','LC_ALL','SSL_CERT_FILE'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  // A dedicated config and an absent ADC sentinel prevent fallback into unrelated
  // host gcloud credentials. No OAuth token/client secret/proxy variables are inherited.
  Object.assign(env,{GOOGLE_WORKSPACE_CLI_CONFIG_DIR:nativeConfig,GOOGLE_APPLICATION_CREDENTIALS:path.join(nativeConfig,'NO_HOST_ADC_ALLOWED'),NO_COLOR:'1'});
  try{return await new Promise((resolve,reject)=>{
   let chunks=[],bytes=0,finished=false,limit=false,timedOut=false;
   const child=spawn(executable,[...METHODS[method],'--params',JSON.stringify(params),'--format','json'],{cwd,env,stdio:['ignore','pipe','pipe'],shell:false});
   const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),500).unref();},timeoutMs);
   const done=(error,result)=>{if(finished)return;finished=true;clearTimeout(timer);error?reject(error):resolve(result);};
   child.stdout.on('data',b=>{bytes+=b.length;if(bytes>maxBytes){limit=true;child.kill('SIGTERM');return;}chunks.push(b);});child.stderr.on('data',()=>{});
   child.once('error',()=>done(err('INBOX_CLI_MISSING','The Gmail CLI could not start. Check its supported executable.')));
   child.once('close',code=>{
    if(timedOut)return done(err('INBOX_TIMEOUT','The Gmail read timed out. Other applications can continue.'));
    if(limit)return done(err('INBOX_LIMIT','The Gmail response exceeded the read limit. Narrow the query.'));
    if(code!==0)return done(err(code===2?'INBOX_AUTH':'INBOX_UNAVAILABLE',code===2?'The dedicated Gmail connection needs native read-only sign-in. No credentials were copied.':'The Gmail read did not finish. Check the native connection and try again.'));
    try{const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));if(result.error)throw new Error();done(null,result);}catch{done(err('INBOX_RESPONSE','The Gmail CLI returned an invalid read response.'));}
   });
  });}finally{await rm(cwd,{recursive:true,force:true});}
 };
}

export function decodeHeader(value){
 return normalize(String(value||'').slice(0,12000).replace(/=\?([^?\s]+)\?([bq])\?([^?]*)\?=/gi,(_,charset,encoding,data)=>{
  try{const bytes=encoding.toLowerCase()==='b'?Buffer.from(data,'base64'):Buffer.from(data.replace(/_/g,' ').replace(/=([0-9a-f]{2})/gi,(_m,h)=>String.fromCharCode(parseInt(h,16))),'binary');return new TextDecoder(charset,{fatal:true}).decode(bytes);}catch{return '';}
 }));
}
function htmlDecode(text){return text.replace(/&#(x[0-9a-f]+|\d+);/gi,(_m,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):parseInt(n,10);return v>0&&v<=0x10ffff?String.fromCodePoint(v):'';}).replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi,m=>({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '}[m.toLowerCase()]));}
function safeHtmlText(html){return htmlDecode(html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(?:script|style|blockquote)\b[^>]*>[\s\S]*?<\/(?:script|style|blockquote)>/gi,' ').replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/gi,'\n').replace(/<[^>]+>/g,' '));}
const addresses=value=>unique((decodeHeader(value).match(/[A-Za-z0-9][A-Za-z0-9._%+\-]*@[A-Za-z0-9.\-]+\.[A-Za-z]{2,63}/g)||[]).map(v=>v.toLowerCase()));
export function parseGmailMessage(message){
 if(!message||!/^[A-Za-z0-9_-]{1,200}$/.test(message.id||'')||!message.payload)throw err('INBOX_MESSAGE','The Gmail message format is incomplete.');
 const headers=message.payload.headers||[];if(headers.length>250)throw err('INBOX_LIMIT','The message header limit was exceeded.');const get=name=>headers.filter(h=>String(h.name).toLowerCase()===name.toLowerCase()).map(h=>String(h.value||''));
 if(get('from').length!==1||get('subject').length>1)throw err('INBOX_MESSAGE','The email has ambiguous identity headers.');
 const senders=addresses(get('from')[0]);if(senders.length!==1)throw err('INBOX_MESSAGE','The email has an ambiguous sender.');
 const received=Number(message.internalDate);if(!Number.isFinite(received)||received<0)throw err('INBOX_MESSAGE','The email delivery time is missing.');
 let partCount=0,total=0;const plain=[],html=[],links=[];
 function visit(part,depth=0){if(++partCount>60||depth>12)throw err('INBOX_LIMIT','The message MIME structure exceeds safe limits.');const type=String(part.mimeType||'').toLowerCase();if(part.body?.data&&['text/plain','text/html'].includes(type)){
   const data=String(part.body.data);if(data.length>1600000||!/^[A-Za-z0-9_\-+/=\s]*$/.test(data))throw err('INBOX_LIMIT','The message text body is invalid or too large.');const bytes=Buffer.from(data,'base64url');total+=bytes.length;if(total>1000000)throw err('INBOX_LIMIT','The message text exceeds 1 MB.');
   const contentType=(part.headers||[]).find(h=>String(h.name).toLowerCase()==='content-type')?.value||'';const charset=/charset\s*=\s*"?([A-Za-z0-9_-]+)/i.exec(contentType)?.[1]||'utf-8';let body;try{body=new TextDecoder(charset,{fatal:true}).decode(bytes);}catch{throw err('INBOX_MESSAGE','The email uses unsupported text encoding.');}
   if(type==='text/plain')plain.push(body);else{html.push(safeHtmlText(body));for(const m of body.matchAll(/\bhref\s*=\s*["']([^"']{1,4096})["']/gi))links.push(htmlDecode(m[1]));}
  }for(const child of part.parts||[])visit(child,depth+1);
 }
 visit(message.payload);const text=(plain.length?plain:html).join('\n').split(/\n(?:On .{0,250}wrote:|[- ]{2,}Forwarded message[- ]{2,}|From: .{0,180}\n)/i)[0].slice(0,250000);
 for(const m of text.matchAll(/https:\/\/[^\s<>"']{1,4096}/g))links.push(m[0].replace(/[),.;]+$/,''));
 const auth=get('authentication-results').filter(v=>/^\s*mx\.google\.com\s*;/i.test(v));const senderDomain=senders[0].split('@')[1];
 const authenticated=auth.length===1&&/\bdmarc=pass\b/i.test(auth[0])&&new RegExp(`\\bheader\\.from\\s*=\\s*"?${senderDomain.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}(?:[;\\s"]|$)`,'i').test(auth[0]);
 return {id:message.id,threadId:message.threadId||null,sender:senders[0],senderName:decodeHeader(get('from')[0]),recipients:unique(['to','cc','delivered-to','x-original-to'].flatMap(name=>get(name).flatMap(addresses))),subject:decodeHeader(get('subject')[0]||''),receivedAt:new Date(received).toISOString(),receivedMs:received,text,links:unique(links).slice(0,100),authenticated,bodyHash:digest(text)};
}

function requestFingerprint(r){return digest(JSON.stringify(['id','accountId','candidateId','jobId','title','tenant','recipient','purpose','createdAt','expiresAt','allowedHosts','expectedSenders','expectedSubject','employer','requisition','contextToken'].map(k=>[k,r[k]??null])));}
function validateRequest(request,clock){
 if(!request?.id||typeof request.tenant!=='string'||!request.tenant||!['signup','login','verify-email'].includes(request.purpose))throw err('VERIFICATION_REQUEST','A trusted signup, login or email-verification request is required.');
 const start=Date.parse(request.createdAt),end=Date.parse(request.expiresAt);if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start||end-start>3600000||start>clock+60000||clock>end)throw err('VERIFICATION_EXPIRED','The verification request is stale, expired or outside its allowed window.');
 email(request.recipient);if(!Array.isArray(request.expectedSenders)||!request.expectedSenders.length||request.expectedSenders.length>10)throw err('VERIFICATION_REQUEST','Configure exact trusted employer verification senders.');request.expectedSenders.forEach(email);
 if(!Array.isArray(request.allowedHosts)||!request.allowedHosts.length||request.allowedHosts.length>10||request.allowedHosts.some(h=>!/^([a-z0-9][a-z0-9.-]*[a-z0-9])$/.test(h)||h.includes('..')))throw err('VERIFICATION_REQUEST','Configure exact allowed HTTPS verification hosts.');
 if(request.expectedSubject&&String(request.expectedSubject).length>250)throw err('VERIFICATION_REQUEST','Verification subject exceeds its limit.');return {start,end};
}
function purposeMatches(request,message){const text=normalize(message.subject+' '+message.text).toLowerCase();if(/reset (?:your )?password|password reset|forgot (?:your )?password/.test(text))return false;return request.purpose==='login'?/sign[ -]?in|log[ -]?in|one.time password|authentication code/.test(text):/verif(?:y|ication)|confirm (?:your )?(?:email|account)|activate (?:your )?account/.test(text);}
function literalContains(haystack,needle){return normalize(haystack).toLowerCase().includes(normalize(needle).toLowerCase());}
function verificationCandidate(request,message,clock){
 if(!message.authenticated||!request.expectedSenders.map(email).includes(message.sender)||!message.recipients.includes(email(request.recipient)))return null;
 if(message.receivedMs<Date.parse(request.createdAt)||message.receivedMs>Date.parse(request.expiresAt)||message.receivedMs>clock+60000||!purposeMatches(request,message))return null;
 if(request.expectedSubject&&!literalContains(message.subject,request.expectedSubject))return null;
 const validLinks=[];for(const raw of message.links){try{const u=new URL(raw);if(u.protocol!=='https:'||u.username||u.password||u.port&&u.port!=='443'||!request.allowedHosts.includes(u.hostname)||tenantKey(u.toString())!==request.tenant)continue;if(/reset|forgot.?password|privacy|terms/i.test(u.pathname))continue;const challenge=[...u.searchParams].some(([k,v])=>/(?:token|code|ticket|key|verification)/i.test(k)&&v.length>=8)||/(?:verify|confirm|activate|auth)\/[^/]{12,}/i.test(u.pathname);if(!challenge)continue;validLinks.push(u.toString());}catch{}}
 const context=message.subject+' '+message.text;
 const subjectBound=Boolean(request.expectedSubject&&literalContains(message.subject,request.expectedSubject));
 const strongContext=request.contextToken?literalContains(context,request.contextToken):Boolean(request.employer&&literalContains(context,request.employer)&&(!request.requisition||literalContains(context,request.requisition)));
 const codes=unique([...message.text.matchAll(/(?:verification|verifying|security|one.time|authentication|sign[ -]?in|log[ -]?in|confirmation|confirm|verify|code|otp)[^\d]{0,48}(?<![A-Za-z0-9])(\d{4,8})(?![A-Za-z0-9])/gi)].map(m=>m[1]).concat([...message.text.matchAll(/\b(?:code|OTP)\s*(?:is|:|=|-)?\s*([A-Z0-9][A-Z0-9-]{3,11})(?![A-Za-z0-9-])/g)].map(m=>m[1]).filter(v=>/[A-Z]/.test(v)&&/\d/.test(v))));
 if(validLinks.length>1||codes.length>1)throw err('VERIFICATION_AMBIGUOUS','The employer email contains multiple verification results. Complete it manually.');
 if(validLinks.length===1)return {message,link:validLinks[0],code:null};
 if(codes.length===1&&subjectBound&&strongContext)return {message,link:null,code:codes[0]};return null;
}
function senderQuery(senders){return '{'+senders.map(v=>'from:'+email(v)).join(' ')+'}';}
export function redactInboxEvidence(value){return normalize(value).replace(/https?:\/\/[^\s<>"']+/gi,'[link redacted]').replace(/\b(?:access_token|id_token|refresh_token|token|secret|password)\s*[:=]\s*[^\s,;]+/gi,'[secret redacted]').replace(/\b(?:(?:verification|security|authentication|one.time)\s+(?:code|password|passcode)|otp|code)[^\d]{0,24}\d{4,8}(?!\d)/gi,'[code redacted]');}
function summaryEvidence(message,recipient){return {source:'gmail',messageId:message.id,messageUrl:`https://mail.google.com/mail/u/0/#all/${message.id}`,sender:message.sender,recipient,subject:redactInboxEvidence(message.subject),receivedAt:message.receivedAt,bodyHash:message.bodyHash,authentication:'gmail-dmarc-header-pass'};}
export function isAuthenticationMessage(message){const subject=normalize(message.subject);return /verif(?:y|ication)|(?:security|authentication|sign[ -]?in|log[ -]?in|one.time) code|password reset|reset (?:your )?password|confirm (?:your )?(?:email|account)|activate (?:your )?account/i.test(subject)||/\b(?:verification|authentication|security|one.time|confirmation|sign[ -]?in|log[ -]?in)\s+(?:code|password|passcode)\b|\botp\b|verify (?:your )?(?:email|account)|activate (?:your )?account|password reset/i.test(message.text);}
function jobRequisition(job){if(job.requisition||job.posting?.requisition)return String(job.requisition||job.posting.requisition);try{const u=new URL(job.url),parts=u.pathname.split('/').filter(Boolean);if(['jobs.lever.co','jobs.eu.lever.co'].includes(u.hostname))return parts[1]||null;if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(u.hostname))return u.searchParams.get('gh_jid')||parts.findLast(p=>/^\d+$/.test(p))||null;}catch{}return null;}
function tokenContains(haystack,needle){const text=normalize(haystack).toLowerCase(),value=normalize(needle).toLowerCase();let start=text.indexOf(value);while(start>=0){const before=text[start-1]||'',after=text[start+value.length]||'';if(!/[a-z0-9]/.test(before)&&!/[a-z0-9]/.test(after))return true;start=text.indexOf(value,start+1);}return false;}
function matchingRoleLink(job,raw,requisition){try{const target=new URL(raw),source=new URL(job.url);if(target.protocol!=='https:'||target.username||target.password||target.port&&target.port!=='443')return false;const host=h=>h==='boards.greenhouse.io'?'job-boards.greenhouse.io':h;if(host(target.hostname)!==host(source.hostname))return false;const tenant=u=>tenantKey(u.toString()).replace(/^boards\.greenhouse\.io/,'job-boards.greenhouse.io');return tenant(target)===tenant(source)&&tokenContains(target.pathname+' '+target.search,requisition);}catch{return false;}}
const outcomePatterns=[['offer',/\boffer(?:s|ed|ing)?\b/i],['interview',/invite you to (?:an? )?(?:interview|conversation)|schedule (?:an? |your )?interview|interview invitation/i],['assessment',/complete (?:the |an? |our )?(?:assessment|coding challenge|technical test)|assessment invitation/i],['rejected',/we (?:have )?(?:decided|chosen).{0,65}(?:not to (?:move|proceed)|another candidate)|(?:will not|won't|unable to|not be able to).{0,40}(?:move forward|proceed)|application.{0,40}(?:unsuccessful|not selected)|regret to inform|\b(?:unable to|cannot|can't|will not|won't|not able to)\s+(?:extend\s+)?(?:an?\s+)?offer\b/i],['submitted',/we (?:have )?received your application|your application (?:has been )?(?:received|submitted)|thank you for applying/i]];
const affirmativeOffer=/\b(?:pleased|delighted|excited|happy)\s+to\s+(?:offer|extend)\b|\bwe\s+(?:are\s+)?offering\s+you\b|\bwe\s+(?:would like|want)\s+to\s+offer\s+you\b|\bwe\s+offer\s+you\b/i;
const uncertainOffer=/\b(?:if|unless|whether|may|might|could|should|conditional|contingent|subject to|pending|potential|possible|hope|intend|consider)\b|\bwould\b(?!\s+like\s+to\s+offer)|\b(?:not|never|cannot|can't|unable|won't|without|declin\w*|withdraw\w*|rescind\w*)\b/i;
// These are deliberately bounded English assertion checks, not a language model.
// Inspect outcome-bearing passages and adjacent referential status assertions;
// an unrelated conditional elsewhere in the message is not an outcome qualifier.
const conditionalOutcome=/\b(?:if|unless|once|until|when|after|before|provided|assuming|may|might|could|should|conditional|contingent|subject to|pending|potential|possible|hope|intend|consider)\b|\bwould\b(?!\s+like\s+to\s+(?:offer|invite))|\bwill\s+(?:(?:need|have)\s+to\s+)?(?:invite|schedule|complete)\b/i;
const negativeOutcome=/\b(?:not|never|cannot|can't|unable|won't|cancel\w*|withdraw\w*|rescind\w*)\b/i;
const materialQualification=/\b(?:conditional|contingent|subject to|pending|withdraw\w*|rescind\w*|cancel\w*)\b|\bnot\s+(?:valid|confirmed|approved|available)\b/i;
const outcomeReferences={offer:'offer|position',interview:'interview|invitation',assessment:'assessment|coding challenge|technical test|invitation',submitted:'application|submission|receipt|confirmation'};
function withoutContactFooter(text){
 const start=text.search(/\bif you have (?:any )?questions\b/i);if(start<0)return text;
 const footer=text.slice(start);
 return /^if you have (?:any )?questions(?: about [^,;.!?]*)?[,;]?\s*(?:please\s+)?(?:contact|email|reach out|let us know)\b[^.!?]*[.!?]?\s*$/i.test(footer)&&!materialQualification.test(footer)?text.slice(0,start):text;
}
function adjacentQualification(passages,index,outcome){
 const names=outcomeReferences[outcome];
 const named=new RegExp(`^(?:(?:unfortunately|however|please note|note that)[,:]?\\s*)?(?:this|that|the|your|our)\\s+(?:${names})\\b`,'i');
 const referential=/^(?:(?:unfortunately|however|please note|note that)[,:]?\s*)?(?:this|that|it)\s+(?:is|was|has|had|will|may|might|could|can|remains|would|depends)\b/i;
 // One preceding named assertion, or the next two referential assertions,
 // includes adjacent paragraphs without treating every later "may" as doubt.
 return [index-1,index+1,index+2].some(i=>{
  const text=passages[i]||'';
  if(!materialQualification.test(text))return false;
  if(i<index)return named.test(text);
  // Do not carry a pronoun across an intervening assertion of another outcome.
  if(i===index+2&&outcomePatterns.some(([,pattern])=>pattern.test(passages[index+1]||'')))return false;
  return named.test(text)||referential.test(text);
 });
}
export function classifyEmployerOutcome(body){
 const passages=String(body).split(/\n+|(?<=[.!?])\s+/).map(text=>withoutContactFooter(text).trim()).filter(Boolean);
 const matches=outcomePatterns.filter(([,pattern])=>pattern.test(body)),affirmative=passages.some(text=>affirmativeOffer.test(text));
 const rejected=matches.some(([outcome])=>outcome==='rejected');
 const usable=[];let conflicting=false;
 for(const [outcome,pattern] of matches){
  // A negative offer can be an affirmative rejection; a bare mention of an
  // offer is not enough to record an offer, even beside a genuine receipt.
  if(outcome==='offer'&&!affirmative){if(!rejected)conflicting=true;continue;}
  if(outcome==='rejected'){usable.push(outcome);continue;}
  let actual=false,conditional=false;
  for(const [index,text] of passages.entries()){
   if(!pattern.test(text)||outcome==='offer'&&!affirmativeOffer.test(text))continue;
   const previous=passages[index-1]||'';
   const prerequisite=/^(?:if|unless|once|until|when|after|before|provided|assuming)\b/i.test(previous)&&!/[.!?]$/.test(previous);
   const qualified=adjacentQualification(passages,index,outcome);
   if(negativeOutcome.test(text)||qualified){conflicting=true;continue;}
   if(prerequisite||conditionalOutcome.test(text)||outcome==='offer'&&uncertainOffer.test(text)){conditional=true;continue;}
   actual=true;
  }
  if(outcome==='submitted'&&/\byour application\s+(?:(?:has|had|was|is)\s+)?(?:not|never)\s+(?:been\s+)?(?:received|submitted)\b/i.test(body))conflicting=true;
  if(actual&&conditional)conflicting=true;
  if(actual)usable.push(outcome);
 }
 const distinct=usable.some(outcome=>outcome!=='submitted')?usable.filter(outcome=>outcome!=='submitted'):usable;
 const proposedOutcome=!conflicting&&distinct.length===1?distinct[0]:null;
 return {matches,proposedOutcome,unambiguous:Boolean(proposedOutcome)};
}
function outcomePeers(job,jobs){return jobs.filter(other=>other.id!==job.id&&other.identity!==job.identity&&normalize(other.employer).toLowerCase()===normalize(job.employer).toLowerCase()&&normalize(other.title).toLowerCase()===normalize(job.title).toLowerCase());}
export function outcomeMatchContext(job,profile,jobs){
 const peers=outcomePeers(job,jobs).map(peer=>({id:peer.id,identity:peer.identity,url:peer.url,requisition:jobRequisition(peer)})).sort((a,b)=>a.id.localeCompare(b.id));
 return {jobIdentity:job.identity,candidateId:profile.id||'main',candidateEmail:email(profile.email),profileRevision:profile.updatedAt||null,profileHash:digest(JSON.stringify(profile)),postingHash:job.posting?.sourceHash||null,employer:job.employer,title:job.title,requisition:jobRequisition(job),peerHash:digest(JSON.stringify(peers))};
}
export function currentOutcomeUnique(job,jobs){const requisition=jobRequisition(job);return !outcomePeers(job,jobs).some(peer=>!requisition||jobRequisition(peer)===requisition);}

export class InboxService {
 constructor({store,vault,directory,command,runner,destinationValidator=validateDestination,clock=()=>Date.now(),maxPages=2,maxMessages=30,maxJobs=20}={}){if(!store)throw err('INBOX_CONFIG','InboxService needs a durable store.',500);Object.assign(this,{store,vault,directory,command,clock,destinationValidator});this.runner=runner||createGwsRunner({command,directory});this.injectedRunner=Boolean(runner);this.maxPages=Math.max(1,Math.min(3,maxPages));this.maxMessages=Math.max(1,Math.min(50,maxMessages));this.maxJobs=Math.max(1,Math.min(20,maxJobs));this.busy=false;}
 configure({email:rawEmail,enabled=false,confirmed=false,recipients,expectedSenders=[],lookbackDays=180,autoTrack=false}={}){
  const old=this.store.get('connection',CONNECTION);if(enabled&&confirmed!==true)throw err('INBOX_AUTHORITY','Explicitly enable read-only Gmail access before using the connection.',400);
  const mailbox=email(rawEmail||old?.email);const allowedRecipients=unique((recipients||[mailbox]).map(email));if(!allowedRecipients.includes(mailbox))allowedRecipients.unshift(mailbox);if(allowedRecipients.length>10||!allowedRecipients.length)throw err('INBOX_CONFIG','Configure at most 10 explicit application recipients.',400);
  if(!Array.isArray(expectedSenders))throw err('INBOX_CONFIG','Expected senders must be a list of exact email addresses.',400);if(!Number.isInteger(lookbackDays)||lookbackDays<1||lookbackDays>365)throw err('INBOX_CONFIG','Mailbox lookback must be 1 to 365 whole days.',400);const senders=unique(expectedSenders.map(email));if(senders.length>30)throw err('INBOX_CONFIG','Configure at most 30 exact employer senders.',400);
  return this.store.put('connection',{id:CONNECTION,kind:'gmail-readonly',enabled:enabled===true,verified:false,email:mailbox,recipients:allowedRecipients,expectedSenders:senders,lookbackDays,autoTrack:autoTrack===true,scope:'https://www.googleapis.com/auth/gmail.readonly',revision:(old?.revision||0)+1,authorizedAt:enabled?stamp():null,checkedAt:null,lastErrorCode:null});
 }
 async readiness(){const c=this.store.get('connection',CONNECTION),installed=this.injectedRunner||Boolean(resolveGws(this.command));return {id:CONNECTION,label:'Employer email',status:c?.enabled&&c?.verified&&installed?'ready':installed?'limited':'missing',enabled:c?.enabled===true,verified:c?.verified===true,email:c?.email||null,detail:!installed?'Install the pinned Gmail CLI before connecting.':!c?.enabled?'Read-only Gmail is disabled. Enable a dedicated mailbox connection explicitly.':!c?.verified?'Native read-only Gmail sign-in and an exact mailbox check are required.':'Read-only profile/list/get connection checked. Verification and outcomes remain bound to your configured mailbox and employer context.'};}
 connection(){const c=this.store.get('connection',CONNECTION);if(!c?.enabled)throw err('INBOX_DISABLED','Read-only Gmail access has not been enabled.');return c;}
 guard(c){const live=this.connection();if(live.revision!==c.revision||live.email!==c.email)throw err('INBOX_REVOKED','The Gmail connection changed or was disabled during the read.');if(c._profile){const p=this.store.get('profile',c._profile.id);if(!p||String(p.email).toLowerCase()!==c._profile.email||p.updatedAt!==c._profile.updatedAt)throw err('INBOX_REVOKED','The application profile changed during the Gmail check.');}if(c._request){const r=this.store.get('verification_request',c._request.id);if(!activeVerification(r)||requestFingerprint(r)!==c._request.fingerprint)throw err('VERIFICATION_REVOKED','The account verification request changed or was stopped during the read.');}}
 async read(c,method,params){this.guard(c);if(c._deadline!==undefined&&this.clock()>=c._deadline)throw err('INBOX_TIMEOUT','This bounded Gmail sweep reached its time limit.');if(c._remaining!==undefined&&c._remaining--<=0)throw err('INBOX_LIMIT','This bounded Gmail sweep reached its read limit.');validateRead(method,params);const result=await this.runner(method,params);this.guard(c);return result;}
 async checkIdentity(c){const profile=await this.read(c,'profile',{userId:'me'});if(email(profile.emailAddress)!==c.email){this.store.put('connection',{...this.store.get('connection',CONNECTION),verified:false,lastErrorCode:'INBOX_IDENTITY'});throw err('INBOX_IDENTITY','The native Gmail account does not match the explicitly selected mailbox.');}return profile;}
 async probe({email:rawEmail,enabled,confirmed}={}){
  if(enabled!==true||confirmed!==true)throw err('INBOX_AUTHORITY','Confirm this exact read-only mailbox check first.',400);const c=this.connection();if(email(rawEmail)!==c.email)throw err('INBOX_IDENTITY','Check the configured mailbox address exactly.',400);
  try{await this.checkIdentity(c);const checkedAt=stamp();this.store.put('connection',{...c,verified:true,checkedAt,lastErrorCode:null});return {ready:true,email:c.email,checkedAt};}catch(e){this.guard(c);this.store.put('connection',{...this.store.get('connection',CONNECTION),verified:false,checkedAt:stamp(),lastErrorCode:e.code||'INBOX_UNAVAILABLE'});throw e;}
 }
 async checkedConnection(){const c=this.connection();if(!c.verified)throw err('INBOX_UNVERIFIED','Check the dedicated read-only Gmail connection before reading application messages.');await this.checkIdentity(c);return c;}
 async messages(c,q){const messages=[];let pageToken,hasMore=false;for(let page=0;page<this.maxPages;page++){
  if(c._remaining!==undefined&&c._remaining<2){hasMore=true;break;}
  const params={userId:'me',q,maxResults:Math.min(25,this.maxMessages-messages.length),includeSpamTrash:false};if(pageToken)params.pageToken=pageToken;
  const result=await this.read(c,'list',params);if(!Array.isArray(result.messages||[]))throw err('INBOX_RESPONSE','The Gmail message list is invalid.');
  for(const item of result.messages||[]){if(c._remaining!==undefined&&c._remaining<1){hasMore=true;break;}if(messages.length>=this.maxMessages){hasMore=true;break;}if(messages.some(m=>m.id===item.id))continue;const raw=await this.read(c,'get',{userId:'me',id:item.id,format:'full'});try{messages.push(parseGmailMessage(raw));}catch(error){if(error.code==='INBOX_LIMIT')throw error;}}
  pageToken=result.nextPageToken;hasMore=hasMore||Boolean(pageToken);if(!pageToken||messages.length>=this.maxMessages)break;
 }return {messages,hasMore};}
 async exclusive(work){if(this.busy)throw err('INBOX_BUSY','Another bounded Gmail check is running. Try again shortly.');this.busy=true;try{return await work();}finally{this.busy=false;}}
 async getVerification(incoming){return this.exclusive(()=>this._getVerification(incoming));}
 async _getVerification(incoming){
  const saved=this.store.get('verification_request',incoming?.id);if(!saved||requestFingerprint(saved)!==requestFingerprint(incoming))throw err('VERIFICATION_REQUEST','Verification must use the saved account request and exact trusted context.');
  if(!activeVerification(saved))throw err('VERIFICATION_REQUEST','This account verification request is no longer active.');const operationStart=this.clock(),window=validateRequest(saved,operationStart);const c=await this.checkedConnection();c._remaining=40;c._deadline=operationStart+45000;c._request={id:saved.id,fingerprint:requestFingerprint(saved)};const candidate=this.store.get('profile',saved.candidateId||'main');if(!candidate||email(candidate.email)!==email(saved.recipient))throw err('VERIFICATION_RECIPIENT','This account request no longer matches the application profile.');c._profile={id:candidate.id,email:email(candidate.email),updatedAt:candidate.updatedAt};this.guard(c);if(!c.recipients?.includes(email(saved.recipient)))throw err('VERIFICATION_RECIPIENT','The verification recipient is outside the enabled mailbox scope.');
  const overlap=this.store.list('verification_request').filter(r=>r.id!==saved.id&&activeVerification(r)&&r.tenant===saved.tenant&&String(r.recipient).toLowerCase()===email(saved.recipient)&&r.purpose===saved.purpose&&Date.parse(r.createdAt)<=window.end&&Date.parse(r.expiresAt)>=window.start);if(overlap.length)throw err('VERIFICATION_AMBIGUOUS','More than one account verification request overlaps. Reconcile the account before reading a code.');
   const q=`to:${email(saved.recipient)} after:${Math.floor(window.start/1000)} before:${Math.ceil(window.end/1000)+1} ${senderQuery(saved.expectedSenders)}`+(saved.expectedSubject?' subject:'+quote(saved.expectedSubject):'');
   const {messages,hasMore}=await this.messages(c,q);const candidates=[];for(const message of messages){const candidate=verificationCandidate(saved,message,this.clock());if(candidate)candidates.push(candidate);}
   if(hasMore)throw err('VERIFICATION_AMBIGUOUS','The verification search exceeded its bounded window. Narrow or reconcile the request manually.');if(candidates.length>1)throw err('VERIFICATION_AMBIGUOUS','Multiple fresh employer emails match this request. Complete verification manually.');if(!candidates.length)return {status:'pending',requestId:saved.id};
   const selected=candidates[0],receiptId='gmail-verification-'+digest(selected.message.id).slice(0,24),prior=this.store.get('verification_receipt',receiptId);if(prior&&prior.requestId!==saved.id)throw err('VERIFICATION_REPLAY','This email was already matched to another account request.');if(selected.link){try{await this.destinationValidator(selected.link,{allowedHosts:saved.allowedHosts});}catch{throw err('VERIFICATION_DESTINATION','The verification destination failed its public HTTPS preflight. Complete it manually.');}}this.guard(c);validateRequest(saved,this.clock());
   const evidence=summaryEvidence(selected.message,email(saved.recipient));this.store.put('verification_receipt',{id:receiptId,requestId:saved.id,messageId:selected.message.id,bodyHash:selected.message.bodyHash,matchedAt:stamp()});return {status:'matched',requestId:saved.id,messageId:selected.message.id,code:selected.code,link:selected.link,receivedAt:selected.message.receivedAt,evidence};
 }
 async pollOutcomes(jobs,profile){return this.exclusive(()=>this._pollOutcomes(jobs,profile));}
 async _pollOutcomes(jobs,profile,{advanceCursor=true}={}){
  const operationStart=this.clock(),c=await this.checkedConnection();c._remaining=60;c._deadline=operationStart+60000;const recipient=email(profile?.email);c._profile={id:profile.id||'main',email:recipient,updatedAt:profile.updatedAt};this.guard(c);if(!c.recipients?.includes(recipient))throw err('INBOX_IDENTITY','The application email is outside the explicitly enabled recipients.');
  const proposals=[],skipped=[];let checkedJobs=0,hasMore=false,visited=0;const eligible=unique((Array.isArray(jobs)?jobs:[]).filter(j=>['imported','preparing','ready','needs_you','manual','submitted','uncertain','interview','assessment','offer','rejected'].includes(j.state)).map(j=>j.id)).sort().map(id=>jobs.find(j=>j.id===id));const known=unique([...this.store.list('job'),...(jobs||[])].map(j=>j.id)).map(id=>(jobs||[]).find(j=>j.id===id)||this.store.get('job',id)).filter(Boolean);const cursor=advanceCursor?this.store.get('inbox_cursor','outcomes'):null;let startIndex=cursor?.nextJobId?eligible.findIndex(j=>j.id===cursor.nextJobId):0;if(startIndex<0){startIndex=eligible.findIndex(j=>j.id>cursor.nextJobId);if(startIndex<0)startIndex=0;}const ordered=eligible.slice(startIndex).concat(eligible.slice(0,startIndex)),selected=ordered.slice(0,this.maxJobs);hasMore=selected.length<eligible.length;try{
   for(const job of selected){
    if(c._remaining<2){hasMore=true;break;}visited++;
    const senders=unique((job.mailPolicy?.expectedSenders||job.expectedSenders||c.expectedSenders||[]).map(email));if(!senders.length||!job.employer||!job.title||/not yet verified|not yet read/i.test(job.employer+' '+job.title)){skipped.push({jobId:job.id,reason:'Configure exact trusted employer senders and verify the employer/role before checking responses.'});continue;}
    const lookbackDays=Number.isInteger(c.lookbackDays)?Math.max(1,Math.min(365,c.lookbackDays)):180;const start=this.clock()-lookbackDays*86400000,end=this.clock()+1000;const q=`to:${recipient} after:${Math.floor(start/1000)} before:${Math.ceil(end/1000)} ${senderQuery(senders)} ${quote(job.employer)}`;
    const result=await this.messages(c,q);hasMore=hasMore||result.hasMore;checkedJobs++;
    for(const message of result.messages){if(isAuthenticationMessage(message)||!message.authenticated||!senders.includes(message.sender)||!message.recipients.includes(recipient)||message.receivedMs<start||message.receivedMs>end)continue;
     const body=message.subject+'\n'+message.text;if(!literalContains(body,job.employer))continue;const roleMatched=literalContains(body,job.title),requisition=jobRequisition(job),reqMatched=Boolean(requisition&&(tokenContains(body.replace(/https?:\/\/[^\s<>"']+/gi,' '),requisition)||message.links.some(link=>matchingRoleLink(job,link,requisition))));if(!roleMatched&&!reqMatched)continue;
     const classification=classifyEmployerOutcome(body),{matches,proposedOutcome}=classification;if(!matches.length)continue;const exactIdentity=roleMatched&&(!requisition||reqMatched);const peerJobs=outcomePeers(job,known);const competing=peerJobs.some(other=>{const otherReq=jobRequisition(other);return !requisition||Boolean(otherReq&&(tokenContains(body.replace(/https?:\/\/[^\s<>"']+/gi,' '),otherReq)||message.links.some(link=>matchingRoleLink(other,link,otherReq))));});const matched=classification.unambiguous&&exactIdentity&&!competing&&typeof job.identity==='string'&&Boolean(job.identity);const match=matches[0][1].exec(body),index=match?.index||0;const quoteText=redactInboxEvidence(body.slice(Math.max(0,index-100),Math.min(body.length,index+350)));
     const id='inbox-proposal-'+digest(`${job.id}\0${message.id}`).slice(0,28),matchContext=outcomeMatchContext(job,profile,known);const old=this.store.get('inbox_proposal',id);
     if(old&&old.state!=='open'){if(old.confidence==='matched'&&(!matched||JSON.stringify(old.matchContext)!==JSON.stringify(matchContext))){const rechecks=[...(old.rechecks||[])];if(!rechecks.some(check=>check.contextHash===digest(JSON.stringify(matchContext))&&check.confidence===(matched?'matched':'ambiguous')))rechecks.push({observedAt:stamp(),confidence:matched?'matched':'ambiguous',contextHash:digest(JSON.stringify(matchContext)),reason:'Current inbox context was rechecked. The accepted or dismissed proposal remains historical evidence.'});const annotated={...old,rechecks};this.store.put('inbox_proposal',annotated);proposals.push(annotated);}else proposals.push(old);continue;}
     const evidence={...summaryEvidence(message,recipient),employer:job.employer,title:job.title,requisition,quote:quoteText,matches:{trustedSender:true,recipient:true,deliveryWindow:true,employer:true,role:roleMatched,requisition:requisition?reqMatched:null,uniqueJob:!competing},jobIdentity:job.identity,candidateEmail:recipient};const proposal={id,jobId:job.id,jobIdentity:job.identity,candidateEmail:recipient,messageId:message.id,proposedOutcome,evidence,matchContext,confidence:matched?'matched':'ambiguous',state:'open',reason:matched?'Trusted sender, exact recipient, delivery window, employer, role and available requisition all matched observable message evidence.':'The message has an ambiguous outcome or does not match every available role/requisition identity. Review before changing the application.',createdAt:old?.createdAt||stamp()};this.guard(c);this.store.put('inbox_proposal',proposal);proposals.push(proposal);
    }
   }return {proposals,checkedJobs,skipped,hasMore};
  }finally{if(advanceCursor&&visited>0&&ordered.length){const next=ordered[visited%ordered.length];this.store.put('inbox_cursor',{id:'outcomes',nextJobId:next.id,lastVisitedId:ordered[visited-1].id,visited,checkedAt:stamp()});}}
 }
 async findPriorSubmission(job,profile){const result=await this.exclusive(()=>this._pollOutcomes([job],profile,{advanceCursor:false}));const matched=result.proposals.filter(p=>p.proposedOutcome==='submitted'&&p.confidence==='matched'&&p.jobIdentity===job.identity&&p.candidateEmail===email(profile.email));return matched.length===1?matched[0]:null;}
}
