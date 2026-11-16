import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

// Real local services and retained PDFs, isolated synthetic stores, no employer or account requests.
let hub,directory,external,errors;
const evidence=path.resolve('docs/experience-pass-2026-11-16/journey-redesign');
test.beforeEach(async({page})=>{
 directory=await mkdtemp(path.join(tmpdir(),'hub-journey-ui-'));
 hub=await createHub({directory,port:0,open:false,dev:process.env.HUB_JOURNEY_DEV==='1',discoveryOptions:{fetcher:async()=>{throw new Error('Fixture forbids external requests');}}});
 external=[];errors=[];
 await page.context().route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==hub.baseUrl){external.push(url.href);return route.abort('blockedbyclient');}return route.continue();});
 await page.addInitScript(()=>{const schedule=window.setInterval;window.setInterval=(callback,delay,...args)=>schedule(delay===5000?()=>{}:callback,delay,...args);});
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(hub.launchUrl);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
 await hub.context(false).engine.stop({releaseWorker:false});
});
test.afterEach(async({page})=>{await page.close();await hub?.close();await rm(directory,{recursive:true,force:true});expect(external).toEqual([]);expect(errors).toEqual([]);});
const refresh=async page=>{const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/state');await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await (await response).finished();};
async function chooseQuestion(page,id){const row=page.getByRole('navigation',{name:'Choose a saved question',exact:true}).locator(`[data-question-id=${JSON.stringify(id)}]`);if(!await row.isVisible()&&await page.getByRole('button',{name:'All saved questions',exact:true}).isVisible())await page.getByRole('button',{name:'All saved questions',exact:true}).click();await row.click();await expect(page.locator(`[data-attention-id=${JSON.stringify(id)}]`)).toBeVisible();}
async function shot(page,testInfo,name){await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${testInfo.project.name}-${name}.png`),fullPage:false});}
function addJob(store,index,extra={}){return store.put('job',{id:`journey-job-${index}`,identity:`journey:${index}`,title:`Synthetic engineering intern ${index}`,employer:`Synthetic employer ${index}`,url:`https://fixture.example.invalid/journey/${index}`,state:'needs_you',revision:0,nextAction:'Review the saved question',posting:{sourceHash:`synthetic-posting-${index}`,text:'Synthetic internship posting supplied for an isolated local test.'},...extra});}
async function exactPackage(page){
 const ctx=hub.context(false),store=ctx.store;
 store.put('profile',{id:'main',fullName:'Alex Example',email:'alex@example.invalid',answers:{},links:{}});
 const result=await ctx.resumes.import([{name:'Synthetic finished resume.md',content:Buffer.from('# Alex Example\n\n## Projects\n### Controlled simulation\n- Built a simulated sensor prototype in Python.\n- Measured 12 controlled simulation cases.\n\n## Skills\nPython and signal processing').toString('base64'),mega:false}]);
 expect(result.errors).toEqual([]);
 const job=addJob(store,'review'),resume=store.list('resume')[0],pkg=await ctx.resumes.select(job,resume.id);
 store.put('package',{...pkg,approved:false});store.put('job',{...store.get('job',job.id),packageId:pkg.id,state:'needs_you'});
 store.put('decision',{id:'journey-review',jobId:job.id,code:'package_review',type:'package_review',state:'open',title:'Review this exact resume',reason:'This edited or selected version needs your review.',details:{packageId:pkg.id,hash:pkg.hash}});
 await refresh(page);return {ctx,store,job,pkg};
}

test('first run imports selected links and finished originals before reviewing campaign rules',async({page},testInfo)=>{
 const store=hub.context(false).store;
 await page.getByRole('button',{name:'Browse US internships',exact:true}).click();await expect(page.getByRole('tab',{name:'Discover',exact:true})).toHaveAttribute('aria-selected','true');
 await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('button',{name:'Add selected links',exact:true}).click();
 const importedUrl='https://job-boards.greenhouse.io/journeyfixture/jobs/123456';
 await page.getByLabel('Job links or CSV',{exact:true}).fill(importedUrl);await page.getByRole('button',{name:'Import jobs',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'1 imported'})).toBeVisible();await page.getByRole('button',{name:'Done',exact:true}).click();
 await expect(page.getByRole('button',{name:'Add finished résumés',exact:true})).toBeVisible();await page.getByRole('button',{name:'Add finished résumés',exact:true}).click();
 const original='# Alex Example\n\n## Projects\n### Controlled simulation\n- Built a simulated sensor prototype in Python.\n- Measured 12 controlled simulation cases.\n\n## Skills\nPython and signal processing';
 await page.locator('.upload-zone input[type=file]').setInputFiles({name:'Synthetic finished original.md',mimeType:'text/markdown',buffer:Buffer.from(original)});await page.getByRole('button',{name:'Import 1 resume',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'1 imported'})).toBeVisible();await page.getByRole('button',{name:'Done',exact:true}).click();
 const resume=store.list('resume')[0],retained=await page.request.get(`${hub.baseUrl}/api/files/${encodeURIComponent(resume.id)}?variant=original`);expect(retained.status()).toBe(200);expect(await retained.text()).toBe(original);expect(resume.mega).toBe(false);
 await page.getByRole('button',{name:'Confirm application profile',exact:true}).click();await expect(page.getByRole('dialog',{name:'Candidate profile',exact:true})).toBeVisible();await page.getByLabel('Full name',{exact:true}).fill('Alex Example');await page.getByLabel('Application email',{exact:true}).fill('alex@example.invalid');await page.getByRole('button',{name:'Save profile',exact:true}).click();await expect(page.getByRole('dialog',{name:'Candidate profile',exact:true})).toHaveCount(0);expect(store.get('profile','main').fullName).toBe('Alex Example');expect(store.get('profile','main').email).toBe('alex@example.invalid');
 await page.getByRole('button',{name:'Review campaign rules',exact:true}).click();await expect(page.getByRole('dialog',{name:'Campaign rules',exact:true})).toBeVisible();await page.getByLabel('Maximum applications',{exact:true}).fill('4');await page.getByRole('button',{name:'Save rules',exact:true}).click();await expect(page.getByLabel('Allowed application hosts',{exact:true})).toHaveAttribute('aria-invalid','true');await page.getByLabel('Allowed application hosts',{exact:true}).fill('job-boards.greenhouse.io');await page.getByRole('button',{name:'Save rules',exact:true}).click();await expect(page.getByRole('dialog',{name:'Campaign rules',exact:true})).toHaveCount(0);
 expect(store.get('campaign','main').rules.maxApplications).toBe(4);expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('job')).toHaveLength(1);expect(store.list('job')[0].url).toBe(importedUrl);expect(store.list('package')).toHaveLength(0);expect(store.list('job')[0].evidence||[]).toHaveLength(0);
 await shot(page,testInfo,'first-run-inputs-retained');
});

test('Home question opens its exact review and keeps other questions intact',async({page},testInfo)=>{
 const store=hub.context(false).store,first=addJob(store,'first'),urgent=addJob(store,'urgent');
 store.put('decision',{id:'journey-first',jobId:first.id,code:'account_access',state:'open',title:'Review ordinary employer access'});
 store.put('decision',{id:'journey-urgent',jobId:urgent.id,code:'account_access',state:'open',title:'Review urgent employer access',createdAt:'2026-11-16T10:00:00Z',deadline:new Date(Date.now()+3600000).toISOString()});
 await refresh(page);
 // The action is read from the specific Home attention item, not an undifferentiated inbox link.
 await page.locator('.home-question-list button').filter({has:page.getByText('Review urgent employer access',{exact:true})}).click();
 const heading=page.locator('[data-attention-id="journey-urgent"] h2');await expect(heading).toBeFocused();await expect(heading).toBeInViewport();await expect(page.locator('.decision-card')).toHaveCount(2);await expect(page.getByRole('heading',{name:'Account holds',exact:true})).toHaveCount(0);
 await shot(page,testInfo,'exact-question');expect(store.get('decision','journey-first').state).toBe('open');expect(store.get('campaign','main').enabled).toBe(false);
});

test('exact retained resume is previewed and approved for only its matching application',async({page},testInfo)=>{
 const {store,job,pkg}=await exactPackage(page);
 await page.getByRole('button',{name:'Needs You',exact:true}).click();await chooseQuestion(page,'journey-review');const card=page.locator('[data-attention-id="journey-review"]');
 await expect(card.getByRole('radio')).toHaveCount(0);await expect(card.getByRole('button',{name:'Approve this version',exact:true})).toBeEnabled();
 await card.getByRole('button',{name:'Review résumé',exact:true}).click();await expect(card.locator('.pdf-preview')).toHaveAttribute('data-rendered','true',{timeout:15000});
 await expect(card.getByRole('link',{name:'Open retained file',exact:true})).toHaveAttribute('href',`/api/files/${encodeURIComponent(pkg.id)}?variant=final`);
 await shot(page,testInfo,'resume-review-desktop');await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot(page,testInfo,'resume-review-mobile');
 await card.getByRole('button',{name:'Approve this version',exact:true}).click();await expect.poll(()=>store.get('package',pkg.id).approved).toBe(true);expect(store.get('decision','journey-review').state).toBe('resolved');expect(store.get('job',job.id).state).toBe('ready');expect(store.get('campaign','main').enabled).toBe(false);
});

test('missing or older document evidence offers recovery instead of an unusable approval',async({page},testInfo)=>{
 const {store,job,pkg}=await exactPackage(page);await page.getByRole('button',{name:'Needs You',exact:true}).click();await chooseQuestion(page,'journey-review');const card=page.locator('[data-attention-id="journey-review"]');
 const scenarios=[['missing-binding',undefined,/does not identify an exact retained version/],['missing-file',{packageId:'journey-missing-package'},/requested by this review is missing/],['old-version',{packageId:pkg.id,hash:'older-synthetic-hash'},/refers to an older version/]];
 for(const [name,details,message] of scenarios){store.put('decision',{...store.get('decision','journey-review'),details});await refresh(page);await expect(card.getByText(message)).toBeVisible();await expect(card.getByRole('radio')).toHaveCount(0);await expect(card.getByRole('button',{name:'Approve this version',exact:true})).toHaveCount(0);await expect(card.getByRole('button',{name:'Open current application',exact:true})).toBeVisible();await shot(page,testInfo,`recovery-${name}`);}
 store.put('decision',{...store.get('decision','journey-review'),details:{packageId:pkg.id,hash:pkg.hash}});store.put('package',{...pkg,approved:false,profileRevision:undefined});await refresh(page);await expect(card.getByText(/missing its candidate profile version/)).toBeVisible();await expect(card.getByRole('button',{name:'Approve this version',exact:true})).toHaveCount(0);store.put('package',{...pkg,approved:false});
 store.put('decision',{...store.get('decision','journey-review'),details:{packageId:pkg.id,hash:pkg.hash}});store.put('profile',{...store.get('profile','main'),location:'Synthetic correction'});await refresh(page);await expect(card.getByText(/candidate profile changed/)).toBeVisible();await expect(card.getByRole('button',{name:'Approve this version',exact:true})).toHaveCount(0);await shot(page,testInfo,'recovery-stale-profile');
 await card.getByRole('button',{name:'Open current application',exact:true}).click();await expect(page.locator('.application-inspector')).toBeVisible();await expect(page.locator('.application-inspector')).toContainText(job.title);await expect(page.getByRole('button',{name:'Approve this document',exact:true})).toBeDisabled();expect(store.get('package',pkg.id).approved).toBe(false);
 // Complete the real recovery rather than stopping at its destination.
 await page.getByRole('combobox',{name:'Use a finished resume for this application',exact:true}).selectOption(store.list('resume')[0].id);await expect.poll(()=>store.get('job',job.id).packageId).not.toBe(pkg.id);const replacementId=store.get('job',job.id).packageId;
 await expect(page.getByRole('button',{name:'Approve this document',exact:true})).toBeEnabled();expect(store.get('decision','journey-review').state).toBe('superseded');await shot(page,testInfo,'recovery-replacement-prepared');
 await page.getByRole('button',{name:'Approve this document',exact:true}).click();await expect.poll(()=>store.get('package',replacementId).approved).toBe(true);expect(store.get('package',pkg.id).approved).toBe(false);expect(store.get('job',job.id).state).toBe('ready');expect(store.list('decision').filter(decision=>decision.jobId===job.id&&decision.state==='open')).toHaveLength(0);expect(store.get('campaign','main').enabled).toBe(false);
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'Needs You',exact:true}).click();await expect(page.locator('.decision-card')).toHaveCount(0);await shot(page,testInfo,'recovery-replacement-approved');
});

test('a missing current version recovers through a finished original and exact replacement approval',async({page},testInfo)=>{
 const {store,job,pkg}=await exactPackage(page);
 store.put('job',{...store.get('job',job.id),packageId:'missing-current-journey-version'});store.put('decision',{...store.get('decision','journey-review'),details:{packageId:'missing-current-journey-version',hash:'missing-journey-hash'}});await refresh(page);await page.getByRole('button',{name:'Needs You',exact:true}).click();await chooseQuestion(page,'journey-review');
 await page.getByRole('button',{name:'Open current application',exact:true}).click();const inspector=page.locator('.application-inspector');await expect(inspector.getByRole('tab',{name:'Document',exact:true})).toHaveAttribute('aria-selected','true');await expect(inspector.getByRole('heading',{name:'No document prepared',exact:true})).toBeVisible();
 await inspector.getByRole('combobox',{name:'Select a finished resume for review',exact:true}).selectOption(store.list('resume')[0].id);await expect.poll(()=>store.get('job',job.id).packageId).not.toBe('missing-current-journey-version');const replacementId=store.get('job',job.id).packageId;expect(replacementId).not.toBe(pkg.id);await expect(inspector.getByRole('button',{name:'Approve this document',exact:true})).toBeEnabled();await inspector.getByRole('button',{name:'Approve this document',exact:true}).click();await expect.poll(()=>store.get('package',replacementId).approved).toBe(true);expect(store.get('package',pkg.id).approved).toBe(false);expect(store.get('decision','journey-review').state).toBe('superseded');expect(store.get('job',job.id).state).toBe('ready');expect(store.list('decision').filter(decision=>decision.jobId===job.id&&decision.state==='open')).toHaveLength(0);expect(store.get('campaign','main').enabled).toBe(false);await shot(page,testInfo,'missing-current-version-recovered');
});

test('phone application has its own scroll and returns keyboard focus to its row',async({page},testInfo)=>{
 const store=hub.context(false).store;
 for(let index=0;index<60;index++)addJob(store,index,{state:'imported',nextAction:'Read and verify this selected posting',posting:{sourceHash:`synthetic-${index}`,text:'Synthetic saved posting. '.repeat(600)}});
 await refresh(page);await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Go to Applications',exact:true}).click();
 const row=page.locator('[data-job-id="journey-job-47"]');await row.focus();await page.keyboard.press('Enter');
 const inspector=page.locator('.application-inspector');await expect(inspector.locator('h2')).toBeFocused();await expect(inspector).toHaveAttribute('aria-modal','true');await expect(inspector.getByRole('button',{name:'Close application inspector',exact:true}).getByText('Back',{exact:true})).toBeVisible();
 expect(await inspector.evaluate(element=>element.scrollHeight>element.clientHeight)).toBe(true);await inspector.evaluate(element=>element.scrollTop=element.scrollHeight);expect(await inspector.evaluate(element=>element.scrollTop)).toBeGreaterThan(0);expect(await page.evaluate(()=>document.body.style.overflow)).toBe('hidden');
 await page.keyboard.press('Escape');await expect(inspector).toHaveCount(0);await expect(row).toBeFocused();expect(await page.evaluate(()=>document.body.style.overflow)).not.toBe('hidden');await shot(page,testInfo,'mobile-return-to-row');
 await page.setViewportSize({width:320,height:844});await row.click();await inspector.evaluate(element=>{const sizes=[...element.querySelectorAll('*')].map(child=>[child,parseFloat(getComputedStyle(child).fontSize)]);for(const [child,size] of sizes)child.style.fontSize=`${size*2}px`;});expect(await inspector.evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);const tabBoxes=await inspector.getByRole('tab').evaluateAll(elements=>elements.map(element=>{const box=element.getBoundingClientRect();return {x:box.x,y:box.y,right:box.right,bottom:box.bottom,scroll:element.scrollWidth,width:element.clientWidth};}));for(let i=0;i<tabBoxes.length;i++){expect(tabBoxes[i].scroll).toBeLessThanOrEqual(tabBoxes[i].width+1);for(let j=i+1;j<tabBoxes.length;j++)expect(tabBoxes[i].right<=tabBoxes[j].x+1||tabBoxes[i].bottom<=tabBoxes[j].y+1).toBe(true);}await inspector.getByRole('button',{name:'Close application inspector',exact:true}).focus();await shot(page,testInfo,'mobile-detail-text200');await page.keyboard.press('Escape');await expect(row).toBeFocused();
});
