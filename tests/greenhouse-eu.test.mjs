import test from 'node:test';
import assert from 'node:assert/strict';
import {portalFor,postingIdentity,BrowserAdapter} from '../server/adapters.mjs';
import {tenantKey,accountIdentity,matchVerification} from '../server/accounts.mjs';
import {EmployerAccountAdapter} from '../server/account-adapter.mjs';
import {assessApplicationLimits} from '../server/application-limits.mjs';
import {InboxService} from '../server/inbox.mjs';

const eu='job-boards.eu.greenhouse.io',us='job-boards.greenhouse.io';
const url=(host=eu,board='synthetic-a',id='123')=>`https://${host}/${board}/jobs/${id}`;
const fakeStore=()=>{const records=new Map();return {
 get:(kind,id)=>records.get(`${kind}:${id}`),
 list:kind=>[...records].filter(([key])=>key.startsWith(`${kind}:`)).map(([,value])=>value),
 put:(kind,value)=>{records.set(`${kind}:${value.id}`,value);return value;},
};};

test('Greenhouse recognizes exact EU hosted domain and preserves existing US posting identities',()=>{
 assert.equal(portalFor(url()),'greenhouse');
 assert.equal(postingIdentity(url(),'greenhouse'),'greenhouse:eu:synthetic-a:123');
 assert.equal(postingIdentity(url()+'?utm_source=fixture#application','greenhouse'),postingIdentity(url(),'greenhouse'));
 assert.equal(postingIdentity(url(us),'greenhouse'),'greenhouse:synthetic-a:123');
 assert.equal(postingIdentity(url('boards.greenhouse.io'),'greenhouse'),postingIdentity(url(us),'greenhouse'));
 assert.notEqual(postingIdentity(url(),'greenhouse'),postingIdentity(url(us),'greenhouse'));
 assert.notEqual(postingIdentity(url(),'greenhouse'),postingIdentity(url(eu,'synthetic-b'),'greenhouse'));
 for(const host of [`${eu}.example.invalid`,'job-boards-eu.greenhouse.io','job-boards.eu.greenhouse.io.invalid']){
  assert.equal(portalFor(url(host)),'unsupported');
  assert.throws(()=>postingIdentity(url(host),'greenhouse'),error=>error.code==='posting_identity');
 }
});

test('EU account tenants include employer and keep existing US aliases unchanged',()=>{
 assert.equal(tenantKey(url()),`${eu}/synthetic-a`);
 assert.equal(tenantKey(url()+'?source=fixture'),tenantKey(url()));
 assert.equal(tenantKey(url(eu,'synthetic-a','456')),tenantKey(url()));
 assert.notEqual(tenantKey(url()),tenantKey(url(eu,'synthetic-b')));
 assert.notEqual(accountIdentity(url(),'main'),accountIdentity(url(eu,'synthetic-b'),'main'));
 assert.notEqual(accountIdentity(url(),'main'),accountIdentity(url(us),'main'));
 assert.notEqual(accountIdentity(url(),'main'),accountIdentity(url(),'other-candidate'));
 assert.equal(tenantKey(url(us)),`${us}/synthetic-a`);
 assert.equal(tenantKey(url('boards.greenhouse.io')),'boards.greenhouse.io/synthetic-a');
 assert.throws(()=>tenantKey(`https://${eu}/`),/Employer tenant is missing/);
});

test('actual account lookup cannot reuse another EU employer session',async()=>{
 const store=fakeStore(),reads=[];
 const adapter=new EmployerAccountAdapter({store,vault:{isUnlocked:()=>true,get:async(ref,binding)=>{reads.push({ref,binding});return {syntheticSession:true};}}});
 store.put('campaign',{id:'main',enabled:true,status:'running',rules:{allowedHosts:[eu]}});
 store.put('profile',{id:'main',email:'synthetic@example.invalid'});
 const a=adapter.reference({url:url()}),b=adapter.reference({url:url(eu,'synthetic-b')});
 assert.notEqual(a.accountId,b.accountId);
 store.put('account',{id:a.accountId,tenant:a.tenant,candidateId:'main',email:'synthetic@example.invalid',sessionRef:'synthetic-session-a'});
 assert.equal(await adapter.sessionFor({url:url(eu,'synthetic-b')}),null);
 assert.equal(reads.length,0);
 assert.deepEqual(await adapter.sessionFor({url:url()}),{storageState:{syntheticSession:true},accountId:a.accountId});
 assert.deepEqual(reads,[{ref:'synthetic-session-a',binding:{tenant:`${eu}/synthetic-a`,candidateId:'main',purpose:'browser_session'}}]);
});

test('actual account destination guard rejects same-host other-board and regional redirects',async()=>{
 const adapter=new EmployerAccountAdapter({store:fakeStore()}),account={id:'synthetic-account',tenant:tenantKey(url())};
 let validated=0;const validate=async()=>{validated++;};
 await adapter.guardDestination({url:()=>url(eu,'synthetic-a','456')},account,validate);
 for(const destination of [url(eu,'synthetic-b'),url(us),url(`${eu}.example.invalid`)])
  await assert.rejects(adapter.guardDestination({url:()=>destination},account,validate),error=>error.code==='account_identity');
 assert.equal(validated,4);
});

test('email verification matching rejects a different EU board even on the allowed host',()=>{
 const current=Date.parse('2026-11-16T05:30:00Z');
 const request={id:'synthetic-request',tenant:tenantKey(url()),recipient:'synthetic@example.invalid',purpose:'signup',createdAt:new Date(current-1000).toISOString(),expiresAt:new Date(current+1000).toISOString(),allowedHosts:[eu],expectedSenders:['verify@example.invalid']};
 const message={receivedAt:new Date(current).toISOString(),recipient:request.recipient,sender:'verify@example.invalid',purpose:'signup',tenant:request.tenant,requestId:request.id,link:url(eu,'synthetic-a','456')};
 assert.equal(matchVerification(request,message,current).requestId,request.id);
 for(const destination of [url(eu,'synthetic-b'),url(us),url(`${eu}.example.invalid`)])
  assert.throws(()=>matchVerification(request,{...message,link:destination},current),/Verification destination does not match the employer/);
});

test('actual inspection rejects cross-board and cross-region redirects before reading posting text',async()=>{
 for(const destination of [url(eu,'synthetic-b'),url(us),url(`${eu}.example.invalid`)]){
  const adapter=new BrowserAdapter();let closed=0,bodyReads=0;
  adapter.open=async()=>({portal:'greenhouse',context:{},page:{url:()=>destination,locator:()=>({count:async()=>0,innerText:async()=>{bodyReads++;return 'untrusted';}})}});
  adapter.closeContext=async()=>{closed++;};
  await assert.rejects(adapter.inspect({url:url()}),error=>error.code==='posting_identity');
  assert.equal(bodyReads,0);assert.equal(closed,1);
 }
});

test('employer application-limit evidence cannot cross Greenhouse regions or EU boards',()=>{
 const quote='Applicants may submit a maximum of two applications to Example Labs.';
 const job={id:'synthetic-job',identity:'synthetic-identity',url:url(),title:'Engineering intern',employer:'Example Labs',state:'imported',posting:{title:'Engineering intern',employer:'Example Labs',text:quote,sourceUrl:url(),sourceHash:'synthetic-posting',open:true,observedAt:'2026-11-16T05:30:00Z'}};
 assert.equal(assessApplicationLimits({job,profile:{id:'main'},jobs:[job],userCap:3}).confirmed[0].cap,2);
 for(const sourceUrl of [url(us),url(eu,'synthetic-b')]){
  const changed={...job,posting:{...job.posting,sourceUrl}};
  const report=assessApplicationLimits({job:changed,profile:{id:'main'},jobs:[changed],userCap:3});
  assert.equal(report.confirmed.length,0);assert.equal(report.needsReview,true);
  assert.equal(report.ambiguous[0].reason,'posting_identity_or_source_unverified');
 }
});

async function receiptFixture({link=url(),auth=true,sender='verify@synthetic.invalid',recipient='synthetic@example.invalid',ageMs=1000}={}){
 const current=Date.parse('2026-11-16T05:30:00Z'),store=fakeStore(),candidateEmail='synthetic@example.invalid';
 const raw={
  id:'synthetic-message',threadId:'synthetic-thread',internalDate:String(current-ageMs),
  payload:{
   mimeType:'text/html',
   headers:[{name:'From',value:sender},{name:'To',value:recipient},{name:'Subject',value:'Example Labs application received'},...(auth?[{name:'Authentication-Results',value:`mx.google.com; dmarc=pass header.from=${sender.split('@')[1]}`}]:[])],
   body:{data:Buffer.from(`Your application has been received by Example Labs for Engineering intern.${link?` <a href="${link}">Role</a>`:''}`).toString('base64url')},
  },
 };
 const runner=async(method)=>method==='profile'?{emailAddress:candidateEmail}:method==='list'?{messages:[{id:raw.id}]}:raw;
 const inbox=new InboxService({store,runner,clock:()=>current});
 const profile=store.put('profile',{id:'main',email:candidateEmail});
 const job={id:'synthetic-eu-job',identity:'main|greenhouse:eu:synthetic-a|123|',url:url(),title:'Engineering intern',employer:'Example Labs',state:'imported'};
 inbox.configure({email:candidateEmail,enabled:true,confirmed:true,expectedSenders:['verify@synthetic.invalid']});
 await inbox.probe({email:candidateEmail,enabled:true,confirmed:true});
 return {inbox,profile,job,store};
}

test('EU receipt uses the actual posting-link identity and retains exact match evidence',async()=>{
 const {inbox,profile,job,store}=await receiptFixture();
 const prior=await inbox.findPriorSubmission(job,profile);
 assert.equal(prior?.confidence,'matched');assert.equal(prior.proposedOutcome,'submitted');
 assert.equal(prior.jobIdentity,job.identity);assert.equal(prior.evidence.requisition,'123');
 assert.deepEqual(prior.evidence.matches,{trustedSender:true,recipient:true,deliveryWindow:true,employer:true,role:true,requisition:true,uniqueJob:true});
 assert.equal(store.list('job').length,0,'The inbox proposes a prior receipt without changing job state.');
});

test('EU receipt without posting evidence, with same-host other-board or wrong-region links stays ambiguous',async()=>{
 for(const link of [null,url(eu,'synthetic-b'),url(us),url(`${eu}.example.invalid`),url(eu,'synthetic-a','1234')]){
  const {inbox,profile,job}=await receiptFixture({link});
  const result=await inbox.pollOutcomes([job],profile);
  assert.equal(result.proposals.length,1);assert.equal(result.proposals[0].confidence,'ambiguous');
  assert.equal(result.proposals[0].evidence.matches.requisition,false);
  assert.equal(await inbox.findPriorSubmission(job,profile),null);
 }
});

test('EU receipt exact link does not override sender, mailbox, authentication or freshness checks',async()=>{
 for(const changed of [{auth:false},{sender:'other@synthetic.invalid'},{recipient:'other@example.invalid'},{ageMs:181*86400000}]){
  const {inbox,profile,job,store}=await receiptFixture(changed);
  assert.equal((await inbox.pollOutcomes([job],profile)).proposals.length,0);
  assert.equal(await inbox.findPriorSubmission(job,profile),null);
  assert.equal(store.list('inbox_proposal').length,0);
 }
});
