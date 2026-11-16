import './runtime.mjs';
import {questionFingerprint,writingApprovalMatches,writingSourceUrl,classifyWritingPolicy,writingAnswerHash} from './writing-policy.mjs';
import {extractPostingRequirements,fileAccepts} from './posting-requirements.mjs';
import {supportingControlFingerprint,supportingDocumentMatches} from './supporting-policy.mjs';
import {constants} from 'node:fs';
import {inspectAriaChoice,selectAriaChoice,verifyAriaChoice} from './aria-choice.mjs';
import {basename,extname} from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdir, readFile, open } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export class ApplicationHold extends Error {
  constructor(code,message,details={}) { super(message); this.code=code; this.details=details; this.hold=true; }
}
const unsupported=(message)=>new ApplicationHold('unsupported_portal',message);
export async function readSupportingUploadBytes(document,{question,openFile=open}={}) {let descriptor;try{descriptor=await openFile(document.originalPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await descriptor.stat(),limit=12*1024*1024;if(!info.isFile()||info.size>limit||(info.mode&0o777)!==0o600||typeof process.getuid==='function'&&info.uid!==process.getuid())throw new Error();const chunks=[];let total=0;for(;;){const buffer=Buffer.allocUnsafe(Math.min(65536,limit-total+1));const {bytesRead}=await descriptor.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>limit)throw new Error();chunks.push(buffer.subarray(0,bytesRead));}const bytes=Buffer.concat(chunks,total);if(createHash('sha256').update(bytes).digest('hex')!==document.hash)throw new Error();return bytes;}catch{throw new ApplicationHold('supporting_document_changed','The reviewed supporting file is missing, changed or no longer private. Reattach it for this question.',{question});}finally{await descriptor?.close();}}

export function portalFor(raw) {
  const u=new URL(raw),host=u.hostname.toLowerCase();
  if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(host)) return 'greenhouse';
  if(['jobs.lever.co','jobs.eu.lever.co'].includes(host)) return 'lever';
  return 'unsupported';
}
export function privateAddress(address) {
  const ip=String(address).toLowerCase().replace(/^\[|\]$/g,'');
  if(isIP(ip)===4) {
    const [a,b,c]=ip.split('.').map(Number);
    return a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0||b===2||b===88&&c===99)||a===100&&b>=64&&b<=127||a>=224||a===198&&[18,19,51].includes(b)||a===203&&b===0;
  }
  if(isIP(ip)!==6)return true;
  let value=ip;
  if(value.includes('.'))value=value.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/,(_,a,b,c,d)=>((+a<<8)+ +b).toString(16)+':'+((+c<<8)+ +d).toString(16));
  const sides=value.split('::'),left=sides[0]?sides[0].split(':'):[],right=sides[1]?sides[1].split(':'):[];
  const words=(sides.length===2?[...left,...Array(8-left.length-right.length).fill('0'),...right]:left).map(v=>parseInt(v,16));
  if(words.slice(0,5).every(v=>v===0)&&words[5]===0xffff)return privateAddress(`${words[6]>>8}.${words[6]&255}.${words[7]>>8}.${words[7]&255}`);
  if((words[0]&0xe000)!==0x2000)return true;
  if(words[0]===0x2001&&(words[1]===0||words[1]===0xdb8))return true;
  if(words[0]===0x2002)return privateAddress(`${words[1]>>8}.${words[1]&255}.${words[2]>>8}.${words[2]&255}`);
  return false;
}
export async function validateDestination(raw,{allowedHosts=[],allowLocal=false}={}) {
  let url; try {url=new URL(raw)} catch {throw new ApplicationHold('unsafe_destination','The application URL is invalid')}
  if(url.username||url.password||(!allowLocal&&url.protocol!=='https:')||!['http:','https:'].includes(url.protocol)) throw new ApplicationHold('unsafe_destination','Only public HTTPS employer destinations are allowed');
  if(!allowedHosts.includes(url.hostname)) throw new ApplicationHold('destination_not_allowed',`Allow ${url.hostname} in campaign rules before continuing`);
  if(!allowLocal) {
    const addresses=isIP(url.hostname)?[{address:url.hostname}]:await lookup(url.hostname,{all:true});
    if(!addresses.length||addresses.some(({address})=>privateAddress(address))) throw new ApplicationHold('unsafe_destination','Private network destinations are not allowed');
    if(url.port&&url.port!=='443') throw new ApplicationHold('unsafe_destination','Nonstandard application ports are not supported');
  }
  return url;
}
export function consentFingerprint(label,links=[]) {return createHash('sha256').update(JSON.stringify({label,links})).digest('hex');}
export function postingIdentity(raw,portal) {if(portalFor(raw)!==portal)throw new ApplicationHold('posting_identity','This URL is not a supported route for the selected portal.');const u=new URL(raw),parts=u.pathname.split('/').filter(Boolean);if(portal==='lever'){if(parts.length<2)throw new ApplicationHold('posting_identity','The Lever employer and requisition could not be verified.');return `lever:${u.hostname==='jobs.eu.lever.co'?'eu':'us'}:${parts[0]}:${parts[1]}`;}if(portal==='greenhouse'){const requisition=u.searchParams.get('gh_jid')||parts.findLast(v=>/^\d+$/.test(v));if(!parts[0]||!requisition)throw new ApplicationHold('posting_identity','The Greenhouse employer and requisition could not be verified.');return `greenhouse:${u.hostname==='job-boards.eu.greenhouse.io'?'eu:':''}${parts[0]}:${requisition}`;}throw unsupported('Posting identity is unsupported');}
const clean=(s)=>String(s||'').replace(/\s+/g,' ').trim();
export const normalizeNativeChoice=value=>String(value??'').normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase();
// Bind per-application answers to the actual native question, not just its display label.
export function nativeAnswerFingerprint(question) {
  const q=question||{},tag=q.tag||(q.type==='select'?'select':['writing','writing_review'].includes(q.kind)?'textarea':'input');
  const type=q.type||(tag==='textarea'?'textarea':q.kind==='consent'?'checkbox':q.kind==='document'?'file':'text');
  const length=value=>Number.isInteger(value)&&value>=0?value:null;
  const options=Array.isArray(q.options)?q.options.map(option=>({label:String(option.label),value:String(option.value)})).sort((a,b)=>a.value.localeCompare(b.value)||a.label.localeCompare(b.label)):null;
  return createHash('sha256').update(JSON.stringify({label:String(q.label||''),name:String(q.name||''),tag,type,required:q.required===true,minLength:length(q.minLength),maxLength:length(q.maxLength),accept:String(q.accept||''),multiple:q.multiple===true,sourceUrl:q.sourceUrl?writingSourceUrl(q.sourceUrl):null,options,consentHash:q.consentHash||null})).digest('hex');
}
function ariaQuestion(observed,url){const question={kind:'choice',type:'select',tag:'input',control:'aria-single-choice',label:observed.label,name:observed.name,required:observed.required,canLeaveBlank:!observed.required,sourceUrl:writingSourceUrl(url),options:observed.options.map(option=>({label:option.label,value:option.id}))};if(/agree|consent|privacy|terms/i.test(question.label))question.consentHash=consentFingerprint(question.label,observed.links);return question;}
function boundNativeQuestion(profile,question) {return profile.jobAnswerBindings?.[question.label]?.questionHash===nativeAnswerFingerprint(question)?question:undefined;}
function currentNativeAnswer(profile,question) {
  if(!Object.hasOwn(profile,'jobAnswerBindings'))return profile.answers?.[question.label];
  const binding=profile.jobAnswerBindings?.[question.label];
  if(binding?.questionHash===nativeAnswerFingerprint(question)&&Object.hasOwn(profile.jobAnswers||{},question.label))return profile.jobAnswers[question.label];
  return profile.currentProfileAnswers?.[question.label];
}

function nativeRadioGroup({formToken,name}){const form=[...document.forms].find(form=>form.getAttribute('data-hub-form')===formToken);if(!form||!name)return null;const nodes=[...document.querySelectorAll('input[type=radio]')].filter(el=>el.form===form&&el.name===name);const visible=el=>el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';const label=el=>{const copy=el.labels?.[0]?.cloneNode(true);copy?.querySelectorAll('input,select,textarea,button').forEach(node=>node.remove());return (copy?.textContent||el.getAttribute('aria-label')||'').trim();};const groupLabel=el=>{const group=el.closest('[role=radiogroup]')||el.closest('fieldset');if(!group)return '';const ids=group.getAttribute('aria-labelledby');if(ids)return ids.split(/\s+/).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim();return (group.getAttribute('aria-label')||[...group.children].find(el=>el.tagName==='LEGEND')?.textContent||'').trim();};const enabled=nodes.filter(el=>!el.matches(':disabled')),shown=enabled.filter(visible),labels=[...new Set(shown.map(groupLabel))];return {label:labels.length===1?labels[0]:'',ambiguous:labels.length!==1||!labels[0],visible:enabled.some(el=>visible(el)||[...el.labels||[]].some(visible)),required:enabled.some(el=>el.required||el.getAttribute('aria-required')==='true'),options:shown.slice(0,501).map(el=>({label:label(el),value:el.value,selector:el.getAttribute('data-hub-control')?`[data-hub-control="${el.getAttribute('data-hub-control')}"]`:null})),checkedValues:nodes.filter(el=>el.checked).map(el=>el.value),links:[...new Set(shown.flatMap(el=>{const group=el.closest('[role=radiogroup]')||el.closest('fieldset');return [...group?.querySelectorAll('a[href]')||[]].map(link=>link.href)}))]};}

const closedText=/job (?:is |has been )?(?:closed|filled|no longer available)|position (?:is |has been )?(?:closed|filled)|no longer accepting applications|this job is no longer open/i;

export class BrowserAdapter {
  constructor({directory,allowLocal=false,headless=true,fixturePortal=null,accountAdapter=null}={}) {this.accountAdapter=accountAdapter;this.directory=directory;this.allowLocal=allowLocal;this.headless=headless;this.fixturePortal=fixturePortal;this.contexts=new Set();this.browsers=new Set()}
  async readiness() {
    try { const {chromium}=await import('playwright'); const {existsSync}=await import('node:fs'); return {id:'browser',label:'Application browser',status:existsSync(chromium.executablePath())?'ready':'missing',detail:existsSync(chromium.executablePath())?'Project-owned isolated Chromium browser':'Install the version-matched Chromium browser with npm run browser:install'}; }
    catch { return {id:'browser',label:'Application browser',status:'missing',detail:'Install the locked project dependencies'}; }
  }
  async browser(rules=[]) {const {chromium}=await import('playwright');const browser=await chromium.launch({headless:this.headless,...(rules.length?{args:[`--host-resolver-rules=${rules.join(', ')}`]}:{})});this.browsers.add(browser);return browser;}
  async open(job,policy={},{authenticated=false}={}) {
    const hosts=[...new Set([new URL(job.url).hostname,...(policy.allowedHosts||[])])];
    await validateDestination(job.url,{allowedHosts:hosts,allowLocal:this.allowLocal});
    const portal=this.fixturePortal||portalFor(job.url);
    if(portal==='unsupported') throw unsupported('This portal has no verified adapter yet. Open the application manually and retain its receipt.');
    const pins=[];
    if(!this.allowLocal) {
      for(const host of hosts) {
        try {await validateDestination(`https://${host}/`,{allowedHosts:hosts});const addresses=isIP(host)?[{address:host}]:await lookup(host,{all:true});const address=addresses.find(v=>isIP(v.address)===4)?.address||addresses[0]?.address;if(!address||privateAddress(address))throw new Error('Invalid pin');pins.push(`MAP ${host} ${isIP(address)===6?'['+address+']':address}`);}catch(error){if(host===new URL(job.url).hostname)throw error;}
      }
      pins.push('MAP * ~NOTFOUND');
    }
    const accountContext=authenticated&&this.accountAdapter?await this.accountAdapter.sessionFor(job):null;
    const context=await (await this.browser(pins)).newContext({acceptDownloads:false,serviceWorkers:'block',...(accountContext?.storageState?{storageState:accountContext.storageState}:{})}); this.contexts.add(context);
    await context.route('**/*',async route=>{
      try { const raw=route.request().url(); if(raw.startsWith('data:')||raw==='about:blank') return route.continue(); await validateDestination(raw,{allowedHosts:hosts,allowLocal:this.allowLocal}); await route.continue(); }
      catch {await route.abort('blockedbyclient').catch(()=>{});}
    });
    const page=await context.newPage(); page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(30000);
    try { await page.goto(job.url,{waitUntil:'domcontentloaded'}); await validateDestination(page.url(),{allowedHosts:hosts,allowLocal:this.allowLocal}); return {context,page,portal,accountContext}; }
    catch(error) {await this.closeContext(context);throw error;}
  }
  async closeContext(context) {this.contexts.delete(context);const browser=context.browser();await context.close().catch(()=>{});if(browser){this.browsers.delete(browser);await browser.close().catch(()=>{});}}
  postingKey(raw,portal){if(this.allowLocal){const u=new URL(raw);return u.origin+u.pathname.replace(/\/apply\/?$/,'').replace(/\/$/,'');}return postingIdentity(raw,portal);}
  async pageEmployer(page) {
    let employer=clean(await page.locator('[data-employer],.company-name,[data-testid=company-name],.posting-headline .company-name').first().innerText().catch(()=>''));
    if(!employer)employer=clean(await page.locator('.main-header-logo img').first().getAttribute('alt').catch(()=>''));
    if(!employer){const actualTitle=clean(await page.locator('h1').first().innerText().catch(()=>'')),portal=this.fixturePortal||portalFor(page.url()),documents=await page.locator('script[type="application/ld+json"]').allTextContents();for(const raw of documents.slice(0,20)){if(raw.length>65536)continue;try{const parsed=JSON.parse(raw),items=(Array.isArray(parsed)?parsed:[parsed,...(parsed['@graph']||[])]).slice(0,100);const posting=items.find(v=>v['@type']==='JobPosting'&&normalizeTitle(v.title)===normalizeTitle(actualTitle)&&(v.url||v.mainEntityOfPage?.['@id']||v.mainEntityOfPage||v['@id'])&&this.postingKey(new URL(v.url||v.mainEntityOfPage?.['@id']||v.mainEntityOfPage||v['@id'],page.url()).toString(),portal)===this.postingKey(page.url(),portal));if(posting?.hiringOrganization?.name){employer=clean(posting.hiringOrganization.name);break}}catch{}}}
    return employer;
  }
  async inspect(job,{policy={},profile=null,guard=null,authorized=false}={}) {
    const {context,page,portal,accountContext}=await this.open(job,policy,{authenticated:authorized});
    try {
      if(this.accountAdapter&&authorized&&profile&&guard){const result=await this.accountAdapter.ensure({page,context,job,profile,policy,guard,accountContext,validateUrl:raw=>validateDestination(raw,{allowedHosts:policy.allowedHosts||[],allowLocal:this.allowLocal})});if(result.authenticated){let same=false;try{same=this.postingKey(page.url(),portal)===this.postingKey(job.url,portal)}catch{}if(!same){guard();await page.goto(job.url,{waitUntil:'domcontentloaded'});}}}
      else if(await page.locator('input[type=password]:visible').count())throw new ApplicationHold('account_campaign_required','Enable a defined campaign before accessing this posting through an employer account.',this.accountAdapter?.reference(job,profile?.id||'main')||{});
      if(this.postingKey(page.url(),portal)!==this.postingKey(job.url,portal))throw new ApplicationHold('posting_identity','The posting redirected to a different employer or requisition. Confirm the selected role before continuing.');
      const rawText=await page.locator('body').innerText(),text=clean(rawText);
      if(text.length<100) throw new ApplicationHold('posting_unreadable','The posting did not expose enough readable text. Review it manually.');
      const title=clean(await page.locator('h1').first().innerText().catch(()=>''));
      const employer=await this.pageEmployer(page)||(job.identityConfirmed===true&&text.toLowerCase().includes(String(job.employer).toLowerCase())?clean(job.employer):'');
      if(!title||!employer) throw new ApplicationHold('posting_identity','Confirm the exact employer and role before preparing this application',{title,employer});
      const lines=rawText.split('\n').map(clean).filter(Boolean);
      const requirements=lines.filter(line=>/required|must |eligible|citizen|sponsor|graduat|enroll|deadline|minimum|preferred|bonus|no .*assistance|artificial intelligence|AI.generat/i.test(line)).slice(0,45);
      const documents=await page.locator('input[type=file]').evaluateAll(nodes=>nodes.slice(0,30).map(el=>{const label=el.labels?.[0]?.cloneNode(true);label?.querySelectorAll('input,select,textarea,button').forEach(node=>node.remove());return {label:label?.textContent?.trim()||el.getAttribute('aria-label')||el.name||'',name:el.name,required:el.required||el.getAttribute('aria-required')==='true',accept:el.accept||'',multiple:el.multiple,visible:el.getClientRects().length>0};}));
      const metadata=extractPostingRequirements({jsonLd:await page.locator('script[type="application/ld+json"]').allTextContents(),lines,title,employer,url:page.url(),identityForUrl:raw=>this.postingKey(raw,portal),documents});
      return {title,employer,portal,text:rawText.slice(0,100000),requirements,...metadata,open:!closedText.test(text)&&!metadata.expired,observedAt:new Date().toISOString(),sourceUrl:page.url(),sourceHash:createHash('sha256').update(JSON.stringify({text,deadline:metadata.deadline,deadlineLabel:metadata.deadlineLabel,deadlineUncertain:metadata.deadlineUncertain,documents:metadata.documents})).digest('hex')};
    } finally {await this.closeContext(context);}
  }
  async fillPage(page,profile,pkg,guard,{job=null,sourceProfile=profile}={}) {
    guard();
    const body=await page.locator('body').innerText();
    if(/captcha|verify you are human|security challenge|two.factor authentication|verification code/i.test(body)) throw new ApplicationHold('security_challenge','Complete the employer security challenge manually.');
    const pagePolicy=classifyWritingPolicy(body);if(pagePolicy.automationProhibited)throw new ApplicationHold('employer_rules','The employer prohibits automated application completion. Continue this application manually.',{manualOnly:true,policyQuotes:pagePolicy.quotes.filter(q=>q.kind==='automation')});
    const password=page.locator('input[type=password]:visible');
    if(await password.count()) throw new ApplicationHold('account_access','This application needs an employer account. Account access has not been commissioned. Guest routes are preferred.');
    const controls=await page.locator('input,textarea,select').evaluateAll(nodes=>nodes.map((el,index)=>{if(!el.hasAttribute('data-hub-control'))el.setAttribute('data-hub-control',`hub-${crypto.randomUUID()}`);if(el.form&&!el.form.hasAttribute('data-hub-form'))el.form.setAttribute('data-hub-form',`hub-form-${crypto.randomUUID()}`);return {el,index:el.getAttribute('data-hub-control')}}).filter(({el})=>!el.matches(':disabled')&&el.type!=='hidden'&&el.type!=='submit'&&el.type!=='button').map(({el,index})=>({index,id:el.id,name:el.name,formToken:el.form?.getAttribute('data-hub-form')||null,options:el.tagName==='SELECT'?[...el.options].filter(option=>!option.disabled&&!option.closest('optgroup')?.disabled&&!option.hidden&&String(option.value).trim()).slice(0,501).map(option=>({label:option.label.trim(),value:option.value})):null,accept:el.accept||'',multiple:el.multiple,minLength:el.minLength,maxLength:el.maxLength,type:el.type||el.tagName.toLowerCase(),required:el.required||el.getAttribute('aria-required')==='true',links:[...el.labels?.[0]?.querySelectorAll('a[href]')||[]].map(a=>a.href),label:((()=>{const label=el.labels?.[0];if(!label)return '';const copy=label.cloneNode(true);copy.querySelectorAll('input,textarea,select,button').forEach(node=>node.remove());return copy.textContent;})()||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.name||'').trim(),tag:el.tagName.toLowerCase(),role:el.getAttribute('role')||''})));
    const missing=[],expected=[],processedRadioGroups=new Set();
    const names=String(profile.fullName||'').trim().split(/\s+/);
    const values={name:profile.fullName,full_name:profile.fullName,first_name:names[0],last_name:names.slice(1).join(' '),email:profile.email,phone:profile.phone,location:profile.location};
    const normalize=s=>String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();
    for(const control of controls) {
      guard();
      const selector=`[data-hub-control="${control.index}"]`;
      const locator=page.locator(selector);
      if(control.role==='combobox'&&control.tag!=='select'){
        guard();const count=await locator.count();guard();if(count!==1)throw new ApplicationHold('form_changed','The custom employer input is duplicated or changed.');const shown=await locator.isVisible().catch(()=>false);guard();if(!shown)continue;
        const observed=await inspectAriaChoice(page,selector,guard),question=ariaQuestion(observed,page.url());
        let value=currentNativeAnswer(profile,question);
        if(question.consentHash&&value!==null){const approval=profile.consentApprovals?.[question.label];if(Object.hasOwn(profile,'jobAnswerBindings')&&profile.jobAnswerBindings?.[question.label]?.questionHash!==nativeAnswerFingerprint(question)||approval?.postingHash!==pkg.postingHash||approval.consentHash!==question.consentHash||approval.answer!==value)value=undefined;}
        if(value===null&&!question.required){if(observed.selected.label||observed.selected.hiddenValues.some(item=>item.value))throw new ApplicationHold('custom_form_controls','This optional custom choice already has an answer. Clear it manually or choose an actual option.',{question});expected.push({selector,type:'aria_choice',question,review:observed});continue;}
        const match=typeof value==='string'?observed.options.find(option=>normalizeNativeChoice(option.label)===normalizeNativeChoice(value)):null;
        if(!match){missing.push(question);continue;}
        const selected=await selectAriaChoice(page,selector,observed,match,guard);
        expected.push({selector,type:'aria_choice',question,review:selected});continue;
      }
      if(control.type==='radio'){const groupKey=`${control.formToken||''}:${control.name||''}`;if(processedRadioGroups.has(groupKey))continue;const group=await page.evaluate(nativeRadioGroup,{formToken:control.formToken,name:control.name});if(!group){if(await locator.isVisible().catch(()=>false)||await locator.evaluate(el=>[...el.labels||[]].some(label=>label.getClientRects().length>0)))throw new ApplicationHold('custom_form_controls','This radio question has no unambiguous native form and group name. Continue it manually.');continue;}processedRadioGroups.add(groupKey);if(!group.visible)continue;const options=group.options.map(({label,value})=>({label,value}));if(group.ambiguous||!options.length||options.length>500||options.some(option=>!option.label||!option.value)||new Set(options.map(option=>normalizeNativeChoice(option.label))).size!==options.length||new Set(options.map(option=>option.value)).size!==options.length)throw new ApplicationHold('custom_form_controls','This radio question or its actual options are ambiguous. Continue it manually.');const question={kind:'choice',type:'radio',tag:'input',label:group.label,name:control.name,required:group.required,canLeaveBlank:!group.required,sourceUrl:writingSourceUrl(page.url()),options};if(/agree|consent|privacy|terms/i.test(group.label))question.consentHash=consentFingerprint(group.label,group.links);let value=currentNativeAnswer(profile,question);if(question.consentHash&&value!==null){const approval=profile.consentApprovals?.[group.label];if(Object.hasOwn(profile,'jobAnswerBindings')&&profile.jobAnswerBindings?.[question.label]?.questionHash!==nativeAnswerFingerprint(question)||approval?.postingHash!==pkg.postingHash||approval.consentHash!==question.consentHash||approval.answer!==value)value=undefined;}if(value===null&&!group.required){if(group.checkedValues.length)throw new ApplicationHold('custom_form_controls','This optional radio group already has a selected answer. Choose an actual option or clear it manually before submitting.',{question});expected.push({type:'radio_group',selector:group.options[0].selector,formToken:control.formToken,name:control.name,question,selected:null});continue;}const match=typeof value==='string'?group.options.find(option=>normalizeNativeChoice(option.label)===normalizeNativeChoice(value)):null;if(!match){missing.push(question);continue;}guard();await page.locator(match.selector).check();const actual=await page.evaluate(nativeRadioGroup,{formToken:control.formToken,name:control.name});if(actual?.checkedValues.length!==1||actual.checkedValues[0]!==match.value)throw new ApplicationHold('form_changed','The employer radio choice did not match the selected answer.',{question});expected.push({type:'radio_group',selector:match.selector,formToken:control.formToken,name:control.name,question,selected:match.value});continue;}
      if(!await locator.isVisible().catch(()=>false)) continue;
      const label=normalize(control.label),key=normalize(control.name);
      const choiceQuestion=control.tag==='select'?{kind:'choice',type:'select',tag:'select',label:control.label,name:control.name||'',required:control.required,canLeaveBlank:!control.required,sourceUrl:writingSourceUrl(page.url()),options:control.options||[]}:null;if(choiceQuestion){if(/agree|consent|privacy|terms/i.test(choiceQuestion.label))choiceQuestion.consentHash=consentFingerprint(choiceQuestion.label,control.links);const options=choiceQuestion.options;if(!options.length||options.length>500||options.some(option=>!option.label||!option.value)||new Set(options.map(option=>normalizeNativeChoice(option.label))).size!==options.length)throw new ApplicationHold('custom_form_controls','This native select has missing, repeated or too many actual choices. Continue it manually.',{question:choiceQuestion});if(currentNativeAnswer(profile,choiceQuestion)===null&&!control.required){guard();await locator.selectOption([]);if(await locator.inputValue()!=='')throw new ApplicationHold('form_changed','The optional select could not be left blank.',{question:choiceQuestion});expected.push({selector,type:'value',value:'',nativeQuestion:boundNativeQuestion(profile,choiceQuestion)});continue;}}
      const writingQuestion=control.tag==='textarea'?{label:control.label,name:control.name||'',tag:'textarea',minLength:Number.isInteger(control.minLength)&&control.minLength>=0?control.minLength:null,maxLength:Number.isInteger(control.maxLength)&&control.maxLength>=0?control.maxLength:null,required:control.required,canLeaveBlank:!control.required,sourceUrl:writingSourceUrl(page.url())}:null;
      const questionWritingPolicy=writingQuestion?classifyWritingPolicy(body,{questionText:control.label}):null;if(writingQuestion){writingQuestion.questionHash=questionFingerprint(writingQuestion);writingQuestion.policyQuotes=questionWritingPolicy.quotes;writingQuestion.writingPolicy={aiWritingProhibited:questionWritingPolicy.aiWritingProhibited,automationProhibited:questionWritingPolicy.automationProhibited,assessment:questionWritingPolicy.assessment};}
      if(control.type==='file') {
        if(/resume|cv/.test(`${label} ${key}`)) {if(!pkg.finalPath) throw new ApplicationHold('resume_file','The final resume file is missing');if(!fileAccepts({accept:control.accept,name:basename(pkg.finalPath),mime:pkg.mime||''}))throw new ApplicationHold('resume_file_requirements','The verified resume format does not match this employer file requirement. Prepare an accepted PDF or DOCX before uploading.',{mime:pkg.mime||'',extension:extname(pkg.finalPath),document:{label:control.label,name:control.name,required:control.required,accept:control.accept,multiple:control.multiple,visible:true,sourceUrl:page.url(),page:'application',coverage:'observed-native-controls'}});guard();await locator.setInputFiles(pkg.finalPath);const count=await locator.evaluate(el=>el.files?.length||0);if(count!==1)throw new Error('Resume upload did not attach exactly one file');expected.push({selector,type:'file',hash:pkg.hash});}
        else {const question={label:control.label,name:control.name||'',kind:'document',type:'file',accept:control.accept||'',required:control.required,multiple:control.multiple===true,sourceUrl:writingSourceUrl(page.url())};question.questionHash=supportingControlFingerprint(question);if(currentNativeAnswer(profile,question)===null&&!control.required)continue;const document=profile.jobSupportingDocuments?.[question.questionHash],chosen=currentNativeAnswer(profile,question);if(!document||chosen?.documentId!==document.id||!supportingDocumentMatches(document,{job,profile:sourceProfile,question})){missing.push(question);continue;}if(!fileAccepts({accept:question.accept,name:document.name,mime:document.mime}))throw new ApplicationHold('supporting_document_format','The reviewed supporting file does not match this employer’s current upload format.',{question});const bytes=await readSupportingUploadBytes(document,{question});guard();await locator.setInputFiles({name:document.name,mimeType:document.mime,buffer:bytes});if(await locator.evaluate(el=>el.files?.length||0)!==1)throw new ApplicationHold('supporting_document_changed','The employer did not attach exactly the reviewed supporting file.',{question});expected.push({selector,type:'file',hash:document.hash,documentId:document.id,questionHash:question.questionHash,mime:document.mime,nativeQuestion:boundNativeQuestion(profile,question)});}
        continue;
      }
      if(control.type==='checkbox') {
        const isConsent=/agree|consent|privacy|terms/i.test(control.label);
        const question={label:control.label,name:control.name||'',tag:control.tag,type:control.type,kind:'consent',required:control.required,sourceUrl:writingSourceUrl(page.url()),consentHash:consentFingerprint(control.label,control.links)};
        const approval=profile.consentApprovals?.[control.label],answer=currentNativeAnswer(profile,question);
        const bound=!Object.hasOwn(profile,'jobAnswerBindings')||profile.jobAnswerBindings?.[control.label]?.questionHash===nativeAnswerFingerprint(question);
        const explicit=isConsent?(bound&&approval?.postingHash===(pkg.postingHash||null)&&approval.consentHash===question.consentHash?approval.answer:undefined):answer;
        if(explicit===true||explicit==='Yes') {guard();await locator.check();expected.push({selector,type:'checked',value:true,nativeQuestion:boundNativeQuestion(profile,question)});}
        else if(explicit===false||explicit==='No') {guard();await locator.uncheck();expected.push({selector,type:'checked',value:false,nativeQuestion:boundNativeQuestion(profile,question)});}
        else if(control.required||/agree|consent|privacy|terms/i.test(control.label)) missing.push(question);
        continue;
      }
      const answerQuestion=choiceQuestion||writingQuestion||{label:control.label,name:control.name||'',tag:control.tag,type:control.type,minLength:control.minLength,maxLength:control.maxLength,required:control.required,sourceUrl:writingSourceUrl(page.url())};
      let value=currentNativeAnswer(profile,answerQuestion);if(choiceQuestion?.consentHash){const approval=profile.consentApprovals?.[control.label];if(Object.hasOwn(profile,'jobAnswerBindings')&&profile.jobAnswerBindings?.[choiceQuestion.label]?.questionHash!==nativeAnswerFingerprint(choiceQuestion)||approval?.postingHash!==pkg.postingHash||approval.consentHash!==choiceQuestion.consentHash||approval.answer!==value)value=undefined;}
      if(value===undefined) {
        if(/^(?:full )?name(?: required)?$/.test(label)||['name','full name'].includes(key)) value=values.full_name;
        else if(/first name|given name/.test(label)) value=values.first_name;
        else if(/last name|surname|family name/.test(label)) value=values.last_name;
        else if(/^(?:e mail|email)(?: address)?(?: required)?$/.test(label)||key==='email') value=values.email;
        else if(/^(?:phone|phone number|telephone)(?: required)?$/.test(label)||key==='phone') value=values.phone;
        else if(/^(?:current )?location(?: required)?$/.test(label)) value=values.location;
        else if(/linkedin/.test(label)) value=profile.links?.linkedin;
        else if(/github/.test(label)) value=profile.links?.github;
        else if(/website|portfolio/.test(label)) value=profile.links?.website;
      }
      if(value!==undefined&&value!==null&&value!=='') {
        if(writingQuestion){const writingPolicy=questionWritingPolicy;if(writingPolicy.assessment)throw new ApplicationHold('employer_rules','This question is an assessment that requires manual completion.',{manualOnly:true,policyQuotes:writingPolicy.quotes.filter(q=>q.kind==='assessment')});const draft=profile.jobWritingDrafts?.[control.label];if(writingPolicy.aiWritingProhibited&&draft?.answerHash===writingAnswerHash(String(value)))throw new ApplicationHold('employer_rules','The employer requires candidate-authored writing. Replace this drafted answer with your own work or continue manually.',{manualOnly:true,policyQuotes:writingPolicy.quotes});const requiresReview=writingPolicy.aiWritingProhibited||String(value).length>200||Object.hasOwn(profile.jobWritingApprovals||{},control.label)||Object.hasOwn(profile.jobWritingDrafts||{},control.label);if(requiresReview&&!writingApprovalMatches(profile.jobWritingApprovals?.[control.label],{question:writingQuestion,text:value,postingHash:pkg.postingHash,packageHash:pkg.hash,profileRevision:profile.updatedAt})){missing.push({...writingQuestion,kind:'writing_review',existingAnswer:typeof value==='string'?value:''});continue;}if(writingQuestion.maxLength!==null&&String(value).length>writingQuestion.maxLength||writingQuestion.minLength!==null&&String(value).length<writingQuestion.minLength){missing.push({...writingQuestion,kind:'writing_review',existingAnswer:String(value),constraint:'Answer length does not match the employer question.'});continue;}}
        if(choiceQuestion) {const match=choiceQuestion.options.find(option=>normalizeNativeChoice(option.label)===normalizeNativeChoice(value));if(!match){missing.push(choiceQuestion);continue;}const actualIndex=await locator.evaluate((el,expected)=>[...el.options].findIndex(option=>!option.disabled&&!option.closest('optgroup')?.disabled&&option.value===expected.value&&option.label.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase()===expected.label),{value:match.value,label:normalizeNativeChoice(match.label)});if(actualIndex<0)throw new ApplicationHold('form_changed','The employer select options changed after the question was read.',{question:choiceQuestion});guard();await locator.selectOption({index:actualIndex});const selected=await locator.evaluate(el=>[...el.selectedOptions].map(option=>({label:option.label,value:option.value})));if(selected.length!==1||selected[0].value!==match.value||normalizeNativeChoice(selected[0].label)!==normalizeNativeChoice(match.label))throw new ApplicationHold('form_changed','The employer select value did not match the chosen actual option.',{question:choiceQuestion});expected.push({selector,type:'select_choice',question:choiceQuestion,selectedOption:{label:match.label,value:match.value}});}
        else {guard();await locator.fill(String(value));}
        const actual=await locator.inputValue();expected.push({selector,type:'value',value:actual,nativeQuestion:boundNativeQuestion(profile,answerQuestion)});
        if(control.tag!=='select'&&actual!==String(value)) throw new Error(`Entered value did not match ${control.label}`);
      } else if(control.required||value!==null) missing.push(choiceQuestion|| (writingQuestion?{...writingQuestion,kind:'writing'}:{...answerQuestion,kind:'answer',canLeaveBlank:!control.required}));
    }
    if(missing.length) throw new ApplicationHold('form_questions','Answer the employer’s remaining questions before continuing',{questions:missing.slice(0,8)});
    return expected;
  }
  async verifyAriaEntry(page,entry,guard){const observed=await verifyAriaChoice(page,entry.selector,entry.review,guard);if(nativeAnswerFingerprint(ariaQuestion(observed,page.url()))!==nativeAnswerFingerprint(entry.question))throw new ApplicationHold('form_changed','The employer custom question or its consent changed before submission.');}
  async verifyForm(page,expected,guard) {
    guard();
    for(const entry of expected) {
      if(entry.type==='aria_choice'){await this.verifyAriaEntry(page,entry,guard);continue;}
      const control=page.locator(entry.selector);
      if(await control.count()!==1)throw new ApplicationHold('form_changed','An application field changed after preparation. Review it before submission.');
      if(entry.nativeQuestion){
        const observed=await control.evaluate((el,sourceUrl)=>{const label=el.labels?.[0]?.cloneNode(true);label?.querySelectorAll('input,textarea,select,button').forEach(node=>node.remove());return {label:(label?.textContent||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.name||'').trim(),name:el.name||'',tag:el.tagName.toLowerCase(),type:el.tagName==='SELECT'?'select':el.type,required:el.required||el.getAttribute('aria-required')==='true',minLength:el.minLength,maxLength:el.maxLength,accept:el.accept||'',multiple:el.multiple===true,sourceUrl,options:el.tagName==='SELECT'?[...el.options].filter(option=>!option.disabled&&!option.closest('optgroup')?.disabled&&!option.hidden&&String(option.value).trim()).slice(0,501).map(option=>({label:option.label.trim(),value:option.value})):null,links:[...el.labels?.[0]?.querySelectorAll('a[href]')||[]].map(link=>link.href)};},writingSourceUrl(page.url()));
        if(entry.nativeQuestion.consentHash)observed.consentHash=consentFingerprint(observed.label,observed.links);
        if(nativeAnswerFingerprint(observed)!==nativeAnswerFingerprint(entry.nativeQuestion))throw new ApplicationHold('form_changed','The employer question or its actual choices changed after the saved answer was applied. Review it before submission.');
      }
      if(entry.type==='select_choice'){const field=await control.evaluate(el=>{const label=el.labels?.[0]?.cloneNode(true);label?.querySelectorAll('input,textarea,select,button').forEach(node=>node.remove());return {label:(label?.textContent||el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.name||'').trim(),name:el.name,required:el.required||el.getAttribute('aria-required')==='true',links:[...el.labels?.[0]?.querySelectorAll('a[href]')||[]].map(link=>link.href)}});if(field.label!==entry.question.label||field.name!==entry.question.name||field.required!==entry.question.required||entry.question.consentHash&&consentFingerprint(field.label,field.links)!==entry.question.consentHash)throw new ApplicationHold('form_changed','The employer select question or consent changed before submission.');const selected=await control.evaluate(el=>[...el.selectedOptions].map(option=>({label:option.label,value:option.value})));if(selected.length!==1||selected[0].value!==entry.selectedOption.value||normalizeNativeChoice(selected[0].label)!==normalizeNativeChoice(entry.selectedOption.label))throw new ApplicationHold('form_changed','The employer select answer changed before submission.');}
      if(entry.type==='radio_group'){const current=await page.evaluate(nativeRadioGroup,{formToken:entry.formToken,name:entry.name});if(!current||current.label!==entry.question.label||current.required!==entry.question.required||entry.question.consentHash&&consentFingerprint(current.label,current.links)!==entry.question.consentHash||JSON.stringify(current.options.map(({label,value})=>({label,value})))!==JSON.stringify(entry.question.options)||current.checkedValues.length!==(entry.selected===null?0:1)||entry.selected!==null&&current.checkedValues[0]!==entry.selected)throw new ApplicationHold('form_changed','The employer radio question, options or checked answer changed before submission.');}
      if(entry.type==='value'&&await control.inputValue()!==entry.value)throw new ApplicationHold('parser_changed_values','The employer resume parser changed an entered value. Correct and review it before submission.');
      if(entry.type==='checked'&&await control.isChecked()!==entry.value)throw new ApplicationHold('form_changed','An application choice changed after preparation.');
      if(entry.type==='file') {
        const uploaded=await control.evaluate(async el=>{if(el.files?.length!==1)return null;const bytes=await el.files[0].arrayBuffer();return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');});
        if(uploaded!==entry.hash)throw new ApplicationHold('attachment_changed','The actual uploaded file no longer matches the verified resume.');
      }
    }
    const invalid=await page.locator('input:invalid,textarea:invalid,select:invalid').count();
    if(invalid)throw new ApplicationHold('form_questions','The employer form still contains invalid or missing required values.');
    const custom=await page.locator('[role=combobox][aria-required=true]:not(select),[role=checkbox][aria-required=true]:not(input[type=checkbox]),[role=radio][aria-required=true]:not(input[type=radio])').evaluateAll((nodes,verified)=>nodes.filter(node=>!verified.some(selector=>node.matches(selector))).length,expected.filter(entry=>entry.type==='aria_choice').map(entry=>entry.selector));
    if(custom)throw new ApplicationHold('custom_form_controls','This employer uses custom required controls. Review them manually before submission.');
  }
  async submit(job,profile,pkg,{guard,policy={},intent,beforeDispatch=()=>{},sourceProfile=profile}={}) {
    if(!pkg.finalPath||!pkg.hash||createHash('sha256').update(await readFile(pkg.finalPath)).digest('hex')!==pkg.hash) throw new ApplicationHold('package_changed','The final resume file does not match its verified version.');
    const {context,page,portal,accountContext}=await this.open(job,policy,{authenticated:true});
    let dispatched=false;
    try {
      const posting=clean(await page.locator('body').innerText());
      if(closedText.test(posting)) throw new ApplicationHold('closed','The employer is no longer accepting applications.');
      // Lever exposes an explicit application route. Greenhouse embeds or reveals its form.
      if(portal==='lever'&&!page.url().replace(/\/$/,'').endsWith('/apply')) {
        const apply=page.getByRole('link',{name:/apply for this job|apply now|apply$/i}).first();
        if(await apply.count()) {guard();await apply.click();await page.waitForLoadState('domcontentloaded');}
      }
      const cumulativeExpected=new Map();
      for(let step=0;step<6;step++) {
        if(this.accountAdapter){const result=await this.accountAdapter.ensure({page,context,job,profile,policy,guard,accountContext,validateUrl:raw=>validateDestination(raw,{allowedHosts:policy.allowedHosts||[],allowLocal:this.allowLocal})});if(result.authenticated){let same=false;try{same=this.postingKey(page.url(),portal)===this.postingKey(job.url,portal)}catch{}if(!same){guard();await page.goto(job.url,{waitUntil:'domcontentloaded'});}}}
        const expected=await this.fillPage(page,profile,{...pkg,postingHash:job.posting?.sourceHash||null},guard,{job,sourceProfile});
        for(const field of expected)cumulativeExpected.set(field.selector,field);
        const next=page.getByRole('button',{name:/^(?:next|continue|review application)$/i}).first();
        if(await next.count()&&await next.isVisible()) {if(!await next.isEnabled())throw new ApplicationHold('form_not_ready','The employer form cannot continue yet. Review invalid fields or wait for its upload checks.');guard();await next.click();continue;}
        const submit=page.getByRole('button',{name:/^(?:submit application|submit your application|send application|apply|submit)$/i}).first();
        if(!await submit.count()) throw new ApplicationHold('form_unrecognized','No supported final submission button was found. Review the application manually.');
        const actualTitle=clean(await page.locator('h1').first().innerText().catch(()=>'')),actualEmployer=await this.pageEmployer(page);
        if(!actualTitle||normalizeTitle(actualTitle)!==normalizeTitle(job.title)||!actualEmployer||normalizeTitle(actualEmployer)!==normalizeTitle(job.employer)||this.postingKey(page.url(),portal)!==this.postingKey(job.url,portal)) throw new ApplicationHold('identity_changed','The employer, role or requisition shown on the form does not exactly match this application. Continue manually if the portal hides this identity.');
        await page.waitForLoadState('networkidle',{timeout:8000}).catch(()=>{});
        if(!await submit.isEnabled()||await submit.getAttribute('aria-disabled')==='true')throw new ApplicationHold('form_not_ready','The employer submission button is disabled. Resolve its form or upload checks before submitting.');
        const nativeReady=await submit.evaluate(button=>!button.form||[...button.form.elements].filter(el=>el.willValidate).every(el=>el.validity.valid));
        if(!nativeReady)throw new ApplicationHold('form_not_ready','The employer form has invalid native values. Correct them before submission.');
        await this.verifyForm(page,[...cumulativeExpected.values()],guard);
        guard();
        // Intent is persisted by Engine before this exact boundary. Never retry a dispatched click.
        const supportingArtifacts=[...cumulativeExpected.values()].filter(field=>field.documentId).map(field=>({documentId:field.documentId,hash:field.hash,questionHash:field.questionHash,mime:field.mime}));
        beforeDispatch({supportingArtifacts});
        dispatched=true;
        await submit.click({timeout:15000});
        await page.waitForFunction(()=>/thank you for applying|application (?:has been )?(?:received|submitted)|successfully submitted|thanks for applying/i.test(document.body?.innerText||''),{},{timeout:15000});
        await page.waitForLoadState('domcontentloaded').catch(()=>{});
        const confirmation=await page.locator('body').innerText();
        const success=/thank you for applying|application (?:has been )?(?:received|submitted)|successfully submitted|thanks for applying/i.test(confirmation);
        const candidate=confirmation.toLowerCase().includes(String(profile.email).toLowerCase());
        const role=normalizeTitle(confirmation).includes(normalizeTitle(job.title));
        const employer=normalizeTitle(confirmation).includes(normalizeTitle(job.employer));
        const reference=await page.locator('[data-confirmation-id]').getAttribute('data-confirmation-id').catch(()=>null);
        if(!success||!candidate||!role||!employer) return {status:'uncertain',reason:'The submission was dispatched, but no receipt matched the candidate, role and employer. Investigate before retrying.'};
        await mkdir(join(this.directory,'evidence'),{recursive:true,mode:0o700});
        const evidenceId=randomUUID(),path=join(this.directory,'evidence',`${evidenceId}.png`);await page.screenshot({path,fullPage:true});
        return {status:'submitted',evidence:{id:evidenceId,type:'employer_confirmation',jobId:job.id,identity:job.identity,candidateId:profile.id||'main',email:profile.email,title:job.title,employer:job.employer,attemptId:intent.id,packageId:pkg.id,packageHash:pkg.hash,supportingArtifacts,url:page.url(),reference:reference||null,observedAt:new Date().toISOString(),path,fixture:this.allowLocal}};
      }
      throw new ApplicationHold('form_steps','The form exceeded the supported page limit. Continue it manually.');
    } catch(error) {if(dispatched)return {status:'uncertain',reason:'The browser stopped after submission dispatch. Reconcile with the employer before retrying.'};throw error;}
    finally {await this.closeContext(context);}
  }
  async close() {for(const c of [...this.contexts])await this.closeContext(c);for(const browser of this.browsers)await browser.close().catch(()=>{});this.browsers.clear();}
}
function normalizeTitle(value) {return clean(value).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();}

// This adapter is explicitly synthetic and may only be installed on a separate demo store.
export class DemoAdapter {
  fixture=true;
  async readiness(){return {id:'browser',label:'Fixture browser route',status:'ready',detail:'Synthetic rehearsal only. No employer is contacted.'};}
  async inspect(job){return {title:job.title||'Software engineering intern',employer:job.employer||'Example Labs',portal:'fixture',text:'Synthetic internship: build a prototype in JavaScript and Python. Enrolled students preferred.',requirements:['Enrolled students preferred'],open:true,observedAt:new Date().toISOString(),sourceUrl:job.url,sourceHash:'synthetic-demo-posting-v1',fixture:true};}
  async submit(job,profile,pkg,{guard,intent,beforeDispatch=()=>{}}) {guard();if(/question|essay/i.test(job.title)&&!profile.answers?.['When can you start?'])throw new ApplicationHold('form_questions','A synthetic employer asks when you can start.',{questions:[{label:'When can you start?',kind:'answer'}]});beforeDispatch();return {status:'submitted',evidence:{id:randomUUID(),type:'employer_confirmation',jobId:job.id,identity:job.identity,candidateId:profile.id||'main',email:profile.email,title:job.title,employer:job.employer,attemptId:intent.id,packageId:pkg.id,packageHash:pkg.hash,observedAt:new Date().toISOString(),fixture:true,url:job.url}};}
  async close(){}
}
