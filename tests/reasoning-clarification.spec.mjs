import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

const question='Which availability should guide this application?';
for(const width of [1366,390])test(`clarification recovery preserves the earlier packet and uses current facts at ${width}`,async({page})=>{
 await page.setViewportSize({width,height:900});
 await page.addInitScript(()=>{const schedule=window.setInterval;window.setInterval=(callback,delay,...args)=>schedule(delay===5000?()=>{}:callback,delay,...args);});
 const directory=await mkdtemp(path.join(tmpdir(),'hub-clarification-ui-')),calls=[];let submissions=0;
 const posting=()=>({title:'Synthetic engineering internship',employer:'Synthetic Labs',portal:'lever',open:true,text:'Python preferred. Synthetic posting version one.',sourceHash:'clarification-ui-posting',sourceUrl:'https://jobs.lever.co/synthetic/clarification-ui',requirements:[]});
 const hub=await createHub({directory,port:0,open:false,
  modelRunner:async input=>{calls.push(structuredClone(input));return {chosenResumeId:input.resumes[0].id,explanation:'Controlled selection of the retained finished source.',edits:[],structureEdits:[],requirements:[],questions:input.scopedAnswers[question]?[]:[{question,reason:'Use the current candidate availability.',options:['June 2027','July 2027']}]};},
  engineAdapter:{readiness:async()=>({id:'browser',status:'limited'}),inspect:async()=>posting(),close:async()=>{},submit:async()=>{submissions++;throw new Error('Synthetic test forbids dispatch');}},
  discoveryOptions:{fetcher:async()=>{throw new Error('Synthetic test forbids source transport');}}});
 const ctx=hub.context(false);clearInterval(ctx.engine.timer);ctx.engine.timer=null;
 try{
  await page.goto(hub.launchUrl);
  const post=async(endpoint,data)=>{const response=await page.request.post(hub.baseUrl+endpoint,{headers:{Origin:hub.baseUrl,'X-Hub-Workspace':'real'},data});expect(response.status()).toBe(200);return response.json();};
  await post('/api/action',{action:'saveProfile',profile:{fullName:'Synthetic Candidate',email:'synthetic@example.invalid',availability:'June 2027'}});
  await post('/api/import/resumes',{files:[{name:'Finished original.md',content:Buffer.from('# Synthetic Candidate\n\n## Projects\n### Controlled simulation\n- Built a simulated Python sensor in controlled tests.\n\n## Skills\nPython\n').toString('base64')}]});
  await post('/api/import/jobs',{text:posting().sourceUrl});ctx.store.put('connection',{id:'model',enabled:true,verified:true});
  const id=ctx.store.list('job')[0].id;ctx.engine.postings.record(ctx.store.get('job',id),posting(),{adopt:true});
  const current=ctx.store.put('job',{...ctx.store.get('job',id),...posting(),posting:posting(),state:'ready'});
  const earlier=await ctx.resumes.select(current,ctx.store.list('resume')[0].id);ctx.store.put('job',{...ctx.store.get('job',id),packageId:earlier.id,state:'ready'});
  await post('/api/action',{action:'prepare',jobId:id});await ctx.engine.tick();
  const old=ctx.store.list('decision').find(item=>item.type==='missing_fact');expect(old?.reasoningBinding).toBeTruthy();expect(ctx.store.get('job',id).packageId).toBe(earlier.id);expect(calls).toHaveLength(1);
  await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
  await page.getByRole('button',{name:'Go to Applications',exact:true}).click();
  if(width<700)await page.getByLabel('Internship section',{exact:true}).selectOption('settings');else await page.getByRole('tab',{name:'Settings',exact:true}).click();
  await page.getByRole('button',{name:'Edit profile',exact:true}).click();await page.getByLabel('Availability',{exact:true}).fill('July 2027');await page.getByRole('button',{name:'Save profile',exact:true}).click();
  await expect(page.getByRole('dialog',{name:'Candidate profile',exact:true})).toHaveCount(0);expect(ctx.store.get('profile','main').availability).toBe('July 2027');
  await page.getByRole('button',{name:'Needs You',exact:true}).click();
  const choose=async()=>{const list=page.getByRole('navigation',{name:'Choose a saved question',exact:true});if(await list.isVisible())await list.getByRole('button').filter({hasText:question}).click();};
  await choose();const oldCard=page.locator(`[data-attention-id="${old.id}"]`);
  await oldCard.getByLabel('June 2027',{exact:true}).check();const rejected=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/action'&&response.request().postDataJSON()?.action==='resolveDecision');await oldCard.getByRole('button',{name:'Save answer',exact:true}).click();expect((await rejected).status()).toBe(409);
  expect(calls).toHaveLength(1);expect(ctx.store.get('decision',old.id).state).toBe('open');expect(ctx.store.get('job',id).packageId).toBe(earlier.id);
  await expect(oldCard.getByRole('button',{name:'Prepare with current facts',exact:true})).toBeVisible();
  await oldCard.getByRole('button',{name:'Prepare with current facts',exact:true}).click();await expect.poll(()=>ctx.store.get('job',id).preparationRequested).toBe(true);
  expect(calls).toHaveLength(1);await ctx.engine.tick();
  const next=ctx.store.list('decision').find(item=>item.type==='missing_fact'&&item.state==='open');expect(next.id).not.toBe(old.id);expect(ctx.store.get('decision',old.id).state).toBe('superseded');expect(calls.at(-1).scopedAnswers).toEqual({});expect(calls.at(-1).profile.availability).toBe('July 2027');
  await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await choose();const nextCard=page.locator(`[data-attention-id="${next.id}"]`);await nextCard.getByLabel('July 2027',{exact:true}).check();await nextCard.getByRole('button',{name:'Save answer',exact:true}).click();await expect.poll(()=>ctx.store.get('decision',next.id).state).toBe('resolved');await ctx.engine.tick();
  const result=ctx.store.get('package',ctx.store.get('job',id).packageId);expect(result.verified).toBe(true);expect(result.profileRevision).toBe(ctx.store.get('profile','main').updatedAt);expect(ctx.store.get('package',earlier.id).hash).toBe(earlier.hash);expect(calls.at(-1).scopedAnswers[question]).toBe('July 2027');
  expect(ctx.store.get('campaign','main').enabled).toBe(false);expect(ctx.store.list('run')).toHaveLength(0);expect(submissions).toBe(0);
 }finally{await page.close();await hub.close();await rm(directory,{recursive:true,force:true});}
});
