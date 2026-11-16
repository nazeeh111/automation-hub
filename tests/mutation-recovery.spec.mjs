import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

let hub,directory,ctx,releaseHeld;
test.beforeEach(async({page})=>{
 await page.addInitScript(()=>{const schedule=window.setInterval;window.setInterval=(callback,delay,...args)=>schedule(delay===5000?()=>{}:callback,delay,...args);});
 directory=await mkdtemp(path.join(tmpdir(),'hub-mutation-recovery-'));
 hub=await createHub({directory,port:0,open:false,
  modelRunner:async()=>{throw new Error('No inference permitted');},
  engineAdapter:{close:async()=>{},readiness:async()=>({id:'browser',status:'limited'})},
  discoveryOptions:{fetcher:async()=>{throw new Error('No source network permitted');}}});
 ctx=hub.context(false);await ctx.engine.stop({releaseWorker:false});
 await page.route('**/*',route=>new URL(route.request().url()).origin===hub.baseUrl?route.continue():route.abort());
 await page.goto(hub.launchUrl);
 await page.getByRole('button',{name:/^(Go to Applications|Open workspace|Open application queue|Review paused campaign)$/}).first().click();
});
test.afterEach(async({page})=>{
 releaseHeld?.();releaseHeld=null;
 expect(ctx.store.get('campaign','main').enabled).toBe(false);
 expect(ctx.store.list('run')).toHaveLength(0);expect(ctx.store.get('usage','model')).toBe(null);
 await page.close();await hub.close();await rm(directory,{recursive:true,force:true});
});
const painted=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function holdCommitted(page,endpoint){
 let entered;const committed=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>releaseHeld=resolve);
 await page.route(`**${endpoint}`,async route=>{const response=await route.fetch();expect(response.ok()).toBe(true);entered();await gate;await route.fulfill({response});});
 return {committed,async release(){const returned=page.waitForResponse(response=>response.url()===hub.baseUrl+endpoint);releaseHeld();await returned;await expect(page.getByRole('dialog').locator('button[type=submit]')).toBeEnabled();await painted(page);}};
}
async function profileForm(page,name){
 await page.getByRole('button',{name:'Edit profile',exact:true}).click();
 await page.getByLabel('Full name',{exact:true}).fill(name);
 await page.getByLabel('Application email',{exact:true}).fill('synthetic@example.invalid');
}
async function openImport(page,type='jobs'){
 if(type==='resumes')await page.getByRole('tab',{name:/Resumes/}).click();
 await page.getByRole('button',{name:type==='jobs'?'Import jobs':'Import resumes',exact:true}).first().click();
}

test('an unreadable successful profile response retains the draft and never invents a saved outcome',async({page})=>{
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 let posts=0;await page.route('**/api/action',route=>{posts++;return route.fulfill({status:200,contentType:'application/json',body:'{"truncated":'});});
 await profileForm(page,'Unsubmitted exact profile intent');await page.getByRole('button',{name:'Save profile',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Candidate profile',exact:true});
 await expect(dialog.getByRole('alert')).toContainText(/unreadable|confirm|unknown|reconnect/i);
 await expect(dialog).toBeVisible();await expect(page.getByLabel('Full name',{exact:true})).toHaveValue('Unsubmitted exact profile intent');
 expect(ctx.store.get('profile','main')?.fullName||null).toBe(null);expect(posts).toBe(1);
 await expect(page.getByText('Profile saved.',{exact:true})).toHaveCount(0);
});

for(const reopen of [false,true])test(`a completed job import preserves newer text ${reopen?'after dialog reopen':'in the same dialog'}`,async({page})=>{
 await openImport(page);const first='https://jobs.lever.co/synthetic/committed-import',next='https://jobs.lever.co/synthetic/new-unsaved-intent';
 const held=await holdCommitted(page,'/api/import/jobs');
 await page.getByLabel('Job links or CSV',{exact:true}).fill(first);await page.getByRole('dialog').getByRole('button',{name:'Import jobs',exact:true}).click();await held.committed;
 expect(ctx.store.list('job').map(job=>job.url)).toEqual([first]);
 if(reopen){await page.getByRole('button',{name:'Close dialog',exact:true}).click();await openImport(page);}
 await page.getByLabel('Job links or CSV',{exact:true}).fill(next);await held.release();
 await expect(page.getByLabel('Job links or CSV',{exact:true})).toHaveValue(next);
 // The earlier operation's receipt must not describe the new dialog session.
 if(reopen)await expect(page.getByRole('dialog').getByRole('status')).toHaveCount(0);
 expect(ctx.store.list('job').map(job=>job.url)).toEqual([first]);
});

test('a completed profile save cannot close a later profile editing session',async({page})=>{
 await page.getByRole('tab',{name:'Settings',exact:true}).click();await profileForm(page,'First committed profile');
 const held=await holdCommitted(page,'/api/action');await page.getByRole('button',{name:'Save profile',exact:true}).click();await held.committed;
 expect(ctx.store.get('profile','main').fullName).toBe('First committed profile');
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();await profileForm(page,'Second unsubmitted profile intent');await held.release();
 await expect(page.getByRole('dialog',{name:'Candidate profile',exact:true})).toBeVisible();
 await expect(page.getByLabel('Full name',{exact:true})).toHaveValue('Second unsubmitted profile intent');
 expect(ctx.store.get('profile','main').fullName).toBe('First committed profile');
});

test('a lost earlier save gives a newer dialog scoped recovery without replay or draft loss',async({page})=>{
 await page.getByRole('tab',{name:'Settings',exact:true}).click();
 await profileForm(page,'Earlier committed profile');
 let entered,posts=0;const committed=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>releaseHeld=resolve);
 await page.route('**/api/action',async route=>{posts++;const response=await route.fetch();expect(response.ok()).toBe(true);entered();await gate;await route.abort('failed');});
 await page.getByRole('button',{name:'Save profile',exact:true}).click();await committed;
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();await profileForm(page,'Newer unsaved draft');
 releaseHeld();
 const dialog=page.getByRole('dialog',{name:'Candidate profile',exact:true});
 await expect(dialog.getByRole('alert')).toContainText(/earlier request.*not be confirmed/i);
 await expect(page.getByLabel('Full name',{exact:true})).toHaveValue('Newer unsaved draft');
 await expect(dialog.getByRole('alert')).not.toContainText('Earlier committed profile');
 await expect(page.locator('#main')).toHaveAttribute('inert','');
 await dialog.getByRole('button',{name:'Reconnect workspace',exact:true}).click();
 await expect(page.locator('#main')).not.toHaveAttribute('inert','');
 await expect(dialog).toBeVisible();await expect(page.getByLabel('Full name',{exact:true})).toHaveValue('Newer unsaved draft');
 expect(ctx.store.get('profile','main').fullName).toBe('Earlier committed profile');expect(posts).toBe(1);
});

test('a known server rejection remains announced inside a dialog after newer edits',async({page})=>{
 await page.getByRole('tab',{name:'Settings',exact:true}).click();await profileForm(page,'Rejected profile');
 await page.getByLabel('Preferences',{exact:true}).fill('x'.repeat(100001));
 let entered,posts=0;const rejected=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>releaseHeld=resolve);
 await page.route('**/api/action',async route=>{posts++;const response=await route.fetch();expect(response.status()).toBe(400);entered();await gate;await route.fulfill({response});});
 await page.getByRole('button',{name:'Save profile',exact:true}).click();await rejected;
 await page.getByLabel('Preferences',{exact:true}).fill('Newer short unsaved preferences');releaseHeld();
 const dialog=page.getByRole('dialog',{name:'Candidate profile',exact:true});
 await expect(dialog.getByRole('alert')).toContainText(/earlier request/i);
 await expect(dialog.getByRole('alert')).not.toContainText('Profile is too large');
 await expect(page.getByLabel('Preferences',{exact:true})).toHaveValue('Newer short unsaved preferences');
 await expect(dialog.getByRole('button',{name:'Reconnect workspace',exact:true})).toHaveCount(0);
 await expect(page.locator('#main')).not.toHaveAttribute('inert','');
 expect(ctx.store.get('profile','main')?.fullName||null).toBe(null);expect(posts).toBe(1);
});

test('a completed resume import preserves newer file selection after dialog reopen',async({page})=>{
 await openImport(page,'resumes');
 const held=await holdCommitted(page,'/api/import/resumes');
 const file=name=>({name,mimeType:'text/markdown',buffer:Buffer.from('# Synthetic Candidate\n\n## Skills\nPython\n\n## Projects\n- Built a controlled synthetic simulation.\n')});
 await page.getByRole('dialog').locator('input[type=file]').setInputFiles(file('First committed resume.md'));
 await page.getByRole('button',{name:'Import 1 resume',exact:true}).click();await held.committed;
 expect(ctx.store.list('resume').map(resume=>resume.name)).toEqual(['First committed resume.md']);
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();await openImport(page,'resumes');
 await page.getByRole('dialog').locator('input[type=file]').setInputFiles(file('Second unsubmitted resume.md'));await held.release();
 await expect(page.getByRole('dialog').locator('.selected-files')).toContainText('Second unsubmitted resume.md');
 await expect(page.getByRole('button',{name:'Import 1 resume',exact:true})).toBeEnabled();
 await expect(page.getByRole('dialog').getByRole('status')).toHaveCount(0);
 expect(ctx.store.list('resume').map(resume=>resume.name)).toEqual(['First committed resume.md']);
});

test('an acknowledged import and its input survive a failed refresh and reconnect without replay',async({page})=>{
 await openImport(page);const text='https://jobs.lever.co/synthetic/acknowledged-import';let posts=0;
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/import/jobs')posts++;});
 await page.route('**/api/state',route=>route.abort('failed'));
 await page.getByLabel('Job links or CSV',{exact:true}).fill(text);await page.getByRole('dialog').getByRole('button',{name:'Import jobs',exact:true}).click();
 await expect(page.getByRole('dialog').getByRole('status')).toContainText('1 imported');
 await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
 await expect(page.getByLabel('Job links or CSV',{exact:true})).toHaveValue(text);await expect(page.locator('#main')).toHaveAttribute('inert','');
 expect(ctx.store.list('job')).toHaveLength(1);expect(posts).toBe(1);
 await page.unroute('**/api/state');await page.getByRole('button',{name:'Done',exact:true}).click();await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
 await expect(page.locator('#main')).not.toHaveAttribute('inert','');await expect(page.locator('.application-row')).toHaveCount(1);
 expect(ctx.store.list('job')).toHaveLength(1);expect(posts).toBe(1);
});
