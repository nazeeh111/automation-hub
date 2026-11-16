import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {BrowserAdapter,consentFingerprint} from '../server/adapters.mjs';
import {employerFixture} from './fixtures/employer.mjs';

async function fixture(t,mode='normal') {
 const directory=await mkdtemp(path.join(tmpdir(),'hub-browser-')),site=await employerFixture();
 const adapter=new BrowserAdapter({directory,allowLocal:true,fixturePortal:'greenhouse'});
 t.after(async()=>{await adapter.close();await site.close();await rm(directory,{recursive:true,force:true})});
 const bytes=Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF\n');
 const finalPath=path.join(directory,'synthetic-resume.pdf');await writeFile(finalPath,bytes,{mode:0o600});
 const job={id:'fixture-job',url:site.url+'?mode='+mode,identity:'fixture-candidate:fixture-job',title:'Engineering intern',employer:'Example Labs'};
 const profile={id:'main',fullName:'Synthetic Candidate',email:'synthetic@example.test',answers:{'Available start date':'June'},consentApprovals:{'I agree to the employer privacy notice':{answer:true,postingHash:null,consentHash:consentFingerprint('I agree to the employer privacy notice')}}};
 const pkg={id:'fixture-package',hash:createHash('sha256').update(bytes).digest('hex'),finalPath,verified:true,approved:true};
 return {adapter,site,job,profile,pkg};
}

test('real Chromium fills retained multi-step form, uploads exact file and matches receipt',async t=>{
 const {adapter,site,job,profile,pkg}=await fixture(t);const posting=await adapter.inspect(job);assert.equal(posting.title,'Engineering intern');assert.equal(posting.employer,'Example Labs');assert.equal(posting.open,true);let dispatch=0;
 const result=await adapter.submit(job,profile,pkg,{guard:()=>{},beforeDispatch:()=>dispatch++,intent:{id:'attempt-fixture'}});
 assert.equal(result.status,'submitted');assert.equal(result.evidence.email,profile.email);assert.equal(result.evidence.packageHash,pkg.hash);assert.equal(result.evidence.fixture,true);assert.equal(dispatch,1);assert.equal(site.submissions(),1);
});
test('parser overwrites are caught by final full-value readback before dispatch',async t=>{
 const {adapter,site,job,profile,pkg}=await fixture(t,'parser');let dispatched=0;
 await assert.rejects(adapter.submit(job,profile,pkg,{guard:()=>{},beforeDispatch:()=>dispatched++,intent:{id:'a'}}),error=>error.code==='parser_changed_values');assert.equal(dispatched,0);assert.equal(site.submissions(),0);
});
test('actual uploaded file bytes are rechecked before dispatch',async t=>{
 const {adapter,site,job,profile,pkg}=await fixture(t,'attachment');let dispatched=0;
 await assert.rejects(adapter.submit(job,profile,pkg,{guard:()=>{},beforeDispatch:()=>dispatched++,intent:{id:'a'}}),error=>error.code==='attachment_changed');assert.equal(dispatched,0);assert.equal(site.submissions(),0);
});
test('unknown required writing yields without submission and succeeds after scoped answer',async t=>{
 const {adapter,site,job,profile,pkg}=await fixture(t,'essay');await assert.rejects(adapter.submit(job,profile,pkg,{guard:()=>{},intent:{id:'a'}}),error=>error.code==='form_questions'&&error.details.questions.some(q=>q.label==='Describe a prototype you built'));assert.equal(site.submissions(),0);
 profile.answers['Describe a prototype you built']='I built a synthetic test prototype.';const result=await adapter.submit(job,profile,pkg,{guard:()=>{},beforeDispatch:()=>{},intent:{id:'b'}});assert.equal(result.status,'submitted');assert.equal(site.submissions(),1);
});
test('unknown required consent is never automatically accepted',async t=>{
 const {adapter,site,job,profile,pkg}=await fixture(t);delete profile.consentApprovals['I agree to the employer privacy notice'];await assert.rejects(adapter.submit(job,profile,pkg,{guard:()=>{},intent:{id:'a'}}),error=>error.code==='form_questions'&&error.details.questions.some(q=>q.kind==='consent'));assert.equal(site.submissions(),0);
});
test('receipt reference cannot override a mismatched employer',async t=>{
 const {adapter,site,job,profile,pkg}=await fixture(t,'mismatch');const result=await adapter.submit(job,profile,pkg,{guard:()=>{},beforeDispatch:()=>{},intent:{id:'a'}});assert.equal(result.status,'uncertain');assert.equal(site.submissions(),1);
});
test('employer account and security challenges are scoped holds',async t=>{
 for(const mode of ['account','captcha']) {const {adapter,site,job,profile,pkg}=await fixture(t,mode);await assert.rejects(adapter.submit(job,profile,pkg,{guard:()=>{},intent:{id:'a'}}),error=>error.code===(mode==='account'?'account_access':'security_challenge'));assert.equal(site.submissions(),0);}
});

test('same-host redirects to another requisition or employer are blocked before dispatch',async t=>{
 for(const mode of ['identity','employer']){const {adapter,site,job,profile,pkg}=await fixture(t,mode);let dispatched=0;await assert.rejects(adapter.submit(job,profile,pkg,{guard:()=>{},beforeDispatch:()=>dispatched++,intent:{id:'a'}}),error=>error.code==='identity_changed');assert.equal(dispatched,0);assert.equal(site.submissions(),0);}
});
test('global generic consent and changed consent versions do not authorize employer agreement',async t=>{
 const {adapter,site,job,profile,pkg}=await fixture(t);profile.answers['I agree to the employer privacy notice']=true;delete profile.consentApprovals['I agree to the employer privacy notice'];await assert.rejects(adapter.submit(job,profile,pkg,{guard:()=>{},intent:{id:'a'}}),error=>error.code==='form_questions');profile.consentApprovals['I agree to the employer privacy notice']={answer:true,postingHash:null,consentHash:'old-text-hash'};await assert.rejects(adapter.submit(job,profile,pkg,{guard:()=>{},intent:{id:'b'}}),error=>error.code==='form_questions');assert.equal(site.submissions(),0);
});
