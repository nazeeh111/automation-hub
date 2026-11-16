import test from 'node:test';
import assert from 'node:assert/strict';
import {applicationResults,applicationPage,matchesApplicationFilter,packagePostingCurrent,currentRequirementEntries} from '../web/application-view.mjs';

test('queue search finds all terms across role and employer without mutating saved work',()=>{
 const jobs=[{id:'a',title:'Controls internship',employer:'Example Robotics',state:'needs_you',url:'https://example.invalid/a'},{id:'b',title:'Robotics software intern',employer:'Other Lab',state:'ready'}];const original=JSON.stringify(jobs);
 assert.deepEqual(applicationResults(jobs,{query:'example   controls'}).map(job=>job.id),['a']);assert.deepEqual(applicationResults(jobs,{query:'ROBOTICS',filter:'prepared'}).map(job=>job.id),['b']);assert.equal(JSON.stringify(jobs),original);assert.equal(matchesApplicationFilter({state:'submitted',submissionConfirmation:'candidate_attested'},'confirmed'),false);assert.equal(matchesApplicationFilter({state:'submitted',submissionConfirmation:'fixture'},'confirmed'),true);assert.equal(matchesApplicationFilter({state:'manual'},'held'),true);
});
test('deadline sorting leaves uncertain or missing dates after known dates and keeps stable ties',()=>{
 const jobs=[{id:'uncertain',deadline:'2026-01-01',deadlineUncertain:true},{id:'missing'},{id:'later',deadline:'2027-04-01'},{id:'earlier',deadline:'2027-03-01'},{id:'invalid',deadline:'not a date'}];assert.deepEqual(applicationResults(jobs,{sort:'deadline'}).map(job=>job.id),['earlier','later','uncertain','missing','invalid']);assert.equal(jobs[0].id,'uncertain');
});
test('bounded queue pages reveal an exact selected result and recover when results shrink',()=>{
 const jobs=Array.from({length:85},(_,i)=>({id:`job-${i}`}));const page=applicationPage(jobs,{offset:0,selectedId:'job-74'});assert.equal(page.offset,40);assert.equal(page.items.length,40);assert(page.items.some(job=>job.id==='job-74'));assert.equal(applicationPage(jobs.slice(0,12),{offset:80}).offset,0);assert.equal(applicationPage([],{offset:80}).total,0);assert.equal(applicationPage(jobs,{offset:81}).offset,80);assert.equal(applicationPage(jobs,{offset:-40}).offset,0);
});
test('review readiness rejects unbound, superseded and other-job packages while preserving exact current binding',()=>{
 const job={id:'job-a',identity:'identity-a',posting:{sourceHash:'source-a'},postingObservationId:'observation-a',latestPostingObservationId:'observation-a'};const pkg={postingBinding:{jobIdentity:'identity-a',observationId:'observation-a',sourceHash:'source-a',contentHash:'retained-content-a'}};assert.equal(packagePostingCurrent(job,pkg),true);
 for(const changed of [{...job,latestPostingObservationId:'observation-b'},{...job,postingObservationId:'observation-b'},{...job,identity:'identity-b'},{...job,posting:{sourceHash:'source-b'}}])assert.equal(packagePostingCurrent(changed,pkg),false);
 assert.equal(packagePostingCurrent(job,{}),false);assert.equal(packagePostingCurrent(job,{postingBinding:{...pkg.postingBinding,contentHash:''}}),false);
});
test('application overview uses only requirements bound to the exact posting, candidate revision and identity',()=>{
 const binding={postingHash:'source-a',profileRevision:'candidate-a',jobIdentity:'identity-a'};const job={identity:'identity-a',posting:{sourceHash:'source-a'},requirementLedger:[{id:'current',binding},{id:'old-posting',binding:{...binding,postingHash:'source-old'}},{id:'old-candidate',binding:{...binding,profileRevision:'candidate-old'}},{id:'other-role',binding:{...binding,jobIdentity:'identity-other'}},{id:'unbound'}]};assert.deepEqual(currentRequirementEntries(job,'candidate-a').map(entry=>entry.id),['current']);assert.deepEqual(currentRequirementEntries(job,'candidate-b'),[]);assert.deepEqual(currentRequirementEntries({...job,postingObservationId:'adopted-a',latestPostingObservationId:'newer-b'},'candidate-a'),[]);
});
