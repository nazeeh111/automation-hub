import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';
import {parseDiscoverySource} from '../server/job-discovery.mjs';

// Isolated source fixtures only. Every non-hub browser request is blocked.
let hub,directory,source,external,errors;
const evidence=path.resolve('docs/experience-pass-2026-11-16/ui');
test.beforeEach(async({page})=>{
 directory=await mkdtemp(path.join(tmpdir(),'hub-experience-ui-'));
 hub=await createHub({directory,port:0,open:false,dev:process.env.HUB_EXPERIENCE_DEV==='1',discoveryOptions:{fetcher:async()=>{throw new Error('Fixture forbids external reads');}}});
 external=[];errors=[];
 await page.context().route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==hub.baseUrl){external.push(url.href);return route.abort('blockedbyclient');}return route.continue();});
 await page.addInitScript(()=>{const schedule=window.setInterval;window.setInterval=(callback,delay,...args)=>schedule(delay===5000?()=>{}:callback,delay,...args);});
 page.on('pageerror',error=>errors.push(error.message));
 const store=hub.context(false).store,observed=new Date().toISOString();
 source=parseDiscoverySource('https://job-boards.greenhouse.io/synthetic-experience-lab');
 store.put('discovery_source',{...source,label:'Synthetic Experience Lab',status:'ready',coverage:'complete',lastObservedAt:observed,lastAttemptAt:observed,jobCount:45,revision:1});
 for(let index=0;index<45;index++)store.put('discovery_candidate',{id:`${source.id}:experience-${index}`,sourceId:source.id,provider:'greenhouse',region:'us',externalId:`experience-${index}`,company:'Synthetic Experience Lab',title:`Engineering intern ${String(index).padStart(2,'0')}`,location:'Blacksburg, Virginia',locationScope:'us',employmentType:'internship',description:'Synthetic engineering role with an exact saved posting.',url:`https://job-boards.greenhouse.io/synthetic-experience-lab/jobs/${index+1}`,canonicalUrl:`https://job-boards.greenhouse.io/synthetic-experience-lab/jobs/${index+1}`,firstSeenAt:observed,lastSeenAt:observed,availability:'active',supportStatus:'portal_review_required'});
 await page.goto(hub.launchUrl);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
});
test.afterEach(async({page})=>{expect(external).toEqual([]);expect(errors).toEqual([]);await page.close();await hub?.close();await rm(directory,{recursive:true,force:true});});
const paint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
const refresh=async page=>{const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/state');await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await (await response).finished();await paint(page);};
const browse=async page=>{await page.getByRole('button',{name:'Browse US internships',exact:true}).click();await expect(page.locator('.jd-job-card')).toHaveCount(40);};
async function shot(page,testInfo,name){await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${testInfo.project.name}-${name}.png`),fullPage:true});}
async function flowGeometry(page){return page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,nodes:[...document.querySelectorAll('.home-process-stage')].map(element=>{const box=element.getBoundingClientRect();return {text:element.textContent,width:box.width,height:box.height,scrollHeight:element.querySelector('.home-stage-copy').scrollHeight,clientHeight:element.querySelector('.home-stage-copy').clientHeight,bottom:box.bottom};}),frameBottom:document.querySelector('.home-process').getBoundingClientRect().bottom}));}

test('Home workflow stays readable in document flow at narrow widths and enlarged text',async({page},testInfo)=>{
 const metrics=[];
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:width===1440?900:844});await paint(page);
  const geometry=await flowGeometry(page);metrics.push({width,...geometry});expect(geometry.width).toBeLessThanOrEqual(width);expect(geometry.nodes).toHaveLength(5);if(width===320){const nav=await page.locator('.sidebar').evaluate(element=>({scroll:element.scrollWidth,width:element.clientWidth}));expect(nav.scroll).toBeLessThanOrEqual(nav.width+1);}
  for(const node of geometry.nodes){expect(node.scrollHeight,node.text).toBeLessThanOrEqual(node.clientHeight+1);expect(node.bottom).toBeLessThanOrEqual(geometry.frameBottom+1);}
  const browse=page.locator('.home-next-actions').getByRole('button',{name:'Browse US internships',exact:true});const box=await browse.boundingBox();expect(box.y+box.height).toBeLessThan(width===1440?900:770);await browse.focus();await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Add selected links',exact:true})).toBeFocused();
  await page.evaluate(()=>window.scrollTo(0,0));await shot(page,testInfo,`home-${width}`);
 }
 for(const width of [1440,320]){
  await page.reload();await expect(page.locator('.home-process-stage')).toHaveCount(5);await page.setViewportSize({width,height:1000});
  await page.evaluate(()=>{const sizes=[...document.querySelectorAll('*')].map(element=>[element,parseFloat(getComputedStyle(element).fontSize)]);for(const [element,size] of sizes)element.style.fontSize=`${size*2}px`;});await paint(page);
  const geometry=await flowGeometry(page);metrics.push({width,textScale:2,...geometry});expect(geometry.width).toBeLessThanOrEqual(width);
  for(const node of geometry.nodes){expect(node.scrollHeight,node.text).toBeLessThanOrEqual(node.clientHeight+1);expect(node.bottom).toBeLessThanOrEqual(geometry.frameBottom+1);}
  if(width===320){const labels=await page.locator('.sidebar .nav-item>span').evaluateAll(elements=>elements.map(element=>({scroll:element.scrollWidth,width:element.clientWidth,bottom:element.getBoundingClientRect().bottom,parentBottom:element.closest('button').getBoundingClientRect().bottom})));for(const label of labels){expect(label.scroll).toBeLessThanOrEqual(label.width+1);expect(label.bottom).toBeLessThanOrEqual(label.parentBottom+1);}}
  await page.getByRole('button',{name:'Add selected links',exact:true}).focus();await shot(page,testInfo,`home-text200-${width}`);
 }
 await page.reload();await expect(page.locator('.home-process-stage')).toHaveCount(5);await page.setViewportSize({width:1440,height:1000});
 for(let index=1;index<5;index++)hub.context(false).store.put('automation',{id:`experience-workflow-${index}`,name:['Daily research digest','Document archive','Weekly reading review','Project summary'][index-1],externalUrl:`https://n8n.example.invalid/workflow/experience${index}`,scheduleOwner:'n8n',workflowId:`experience${index}`});await refresh(page);await expect(page.locator('.home-automation')).toHaveCount(5);await expect(page.locator('.external-observation-node')).toHaveCount(4);await expect(page.locator('.external-automation').first()).toContainText('No status has been read');await expect(page.locator('.external-automation').first()).toContainText('Execution and schedules stay in n8n');await shot(page,testInfo,'home-all-automations');
 await writeFile(path.join(evidence,`${testInfo.project.name}-flow-geometry.json`),JSON.stringify(metrics,null,2));
});

test('Home names the next real setup, running, paused and completed action',async({page},testInfo)=>{
 const context=hub.context(false);await context.engine.stop({releaseWorker:false});const store=context.store;
 const primary=page.locator('.home-next-actions .primary');await expect(primary).toHaveText('Browse US internships');
 store.put('job',{id:'home-state-job',title:'Synthetic selected internship',employer:'Synthetic Experience Lab',url:'https://fixture.example.invalid/home-state',state:'imported',nextAction:'Read this exact saved posting'});await refresh(page);await expect(primary).toHaveText('Add finished résumés');await shot(page,testInfo,'home-roles-without-resumes');
 store.put('resume',{id:'home-state-resume',name:'Synthetic finished résumé',mega:false});await refresh(page);await expect(primary).toHaveText('Confirm application profile');store.put('profile',{...store.get('profile','main'),fullName:'Synthetic Candidate',email:'synthetic-candidate@example.invalid'});await refresh(page);await expect(primary).toHaveText('Review campaign rules');
 const campaign=store.get('campaign','main');store.put('campaign',{...campaign,enabled:true,status:'running'});store.put('job',{...store.get('job','home-state-job'),state:'preparing',nextAction:'Preparing the retained version for Synthetic Experience Lab'});store.event('home-state-job','preparation_started',{detail:'Synthetic retained version preparation'});await refresh(page);await expect(page.locator('.internship-automation')).toContainText('Campaign running');await expect(primary).toHaveText('Open application queue');await expect(page.locator('.home-next-description').first()).toHaveText('Preparing the retained version for Synthetic Experience Lab');await expect(page.locator('.stage-resume')).toHaveClass(/is-current/);await shot(page,testInfo,'home-running');
 store.put('campaign',{...store.get('campaign','main'),status:'paused'});await refresh(page);await expect(primary).toHaveText('Review paused campaign');await expect(page.locator('.internship-automation')).toContainText('Campaign paused');await shot(page,testInfo,'home-paused');
 store.put('job',{...store.get('job','home-state-job'),state:'submitted',submissionConfirmation:'candidate_attested'});store.put('campaign',{...store.get('campaign','main'),enabled:false,status:'draft'});await refresh(page);await expect(primary).toHaveText('View outcomes');await expect(page.getByRole('button',{name:/employer-confirmed receipts/})).toHaveCount(0);await shot(page,testInfo,'home-recorded-outcome');
 store.put('discovery_source',{...store.get('discovery_source',source.id),lastObservedAt:new Date(Date.now()-48*60*60*1000).toISOString()});await refresh(page);await expect(page.locator('.home-stale-note')).toContainText('A board observation needs refreshing');await shot(page,testInfo,'home-stale-observation');
 expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('job')).toHaveLength(1);
});

test('pagination keeps loading controls focusable then focuses the committed range',async({page},testInfo)=>{
 await browse(page);
 let release;const blocked=new Promise(resolve=>release=resolve);
 await page.route('**/api/discovery?*',async route=>{if(new URL(route.request().url()).searchParams.get('offset')==='40')await blocked;await route.continue();});
 const next=page.locator('.jd-pagination').getByRole('button',{name:'Next',exact:true});await next.focus();await page.keyboard.press('Enter');
 await expect(next).toHaveAttribute('aria-disabled','true');await expect(next).toBeFocused();await page.keyboard.press('Enter');release();
 await expect(page.locator('.jd-job-card')).toHaveCount(5);const status=page.locator('.jd-results-heading [role=status]');await expect(status).toContainText('Showing 41–45 of 45 roles');await expect(status).toBeFocused();
 expect(await status.evaluate(element=>element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);
 await shot(page,testInfo,'pagination-range-focus');
 await page.locator('.jd-pagination').getByRole('button',{name:'Previous',exact:true}).click();await expect(page.locator('.jd-job-card')).toHaveCount(40);await expect(status).toContainText('Showing 1–40 of 45 roles');await expect(status).toBeFocused();
});

for(const width of [1440,390])test(`queued role opens its exact application with purposeful focus at ${width}`,async({page},testInfo)=>{
 const store=hub.context(false).store;
 for(let index=0;index<60;index++)store.put('job',{id:`experience-queued-${index}`,...(index===47?(width===1440?{discoveryCandidateId:`${source.id}:experience-0`}:{discovery:{candidateId:`${source.id}:experience-0`}}):{}),title:`Selected synthetic engineering role ${index}`,employer:'Synthetic Experience Lab',url:`https://fixture.example.invalid/selected/${index}`,state:'imported',nextAction:'Read this exact saved posting',revision:0,evidence:[]});
 await refresh(page);await page.setViewportSize({width,height:900});await browse(page);await page.locator('.jd-open-role').first().click();await page.getByRole('button',{name:'In application queue',exact:true}).click();
 const inspector=page.locator('.application-inspector');await expect(inspector).toBeVisible();await expect(inspector).toContainText('Selected synthetic engineering role 47');await expect(inspector.locator('h2')).toBeFocused();await expect(page.locator('.application-row.is-selected')).toHaveAttribute('data-job-id','experience-queued-47');
 expect(await inspector.locator('h2').evaluate(element=>element.getBoundingClientRect().top)).toBeGreaterThanOrEqual(0);await shot(page,testInfo,`queued-inspector-${width}`);
 await page.getByRole('button',{name:'Close application inspector',exact:true}).click();await expect(page.locator('[data-job-id="experience-queued-47"]')).toBeFocused();
});

test('form hints, native correction errors and dialog focus preserve entered answers',async({page},testInfo)=>{
 await page.getByRole('button',{name:'Automations',exact:true}).click();const trigger=page.getByRole('button',{name:'Link an n8n workflow',exact:true});await trigger.click();const dialog=page.getByRole('dialog',{name:'Connect an existing workflow'}),name=dialog.getByLabel('Name',{exact:true}),url=dialog.getByLabel('Existing n8n workflow URL',{exact:true});await expect(name).toBeFocused();
 await name.fill('Synthetic workflow retained');await url.fill('not a URL');await dialog.getByRole('button',{name:'Connect workflow',exact:true}).click();await expect(url).toHaveAttribute('aria-invalid','true');await expect(url).toBeFocused();
 const errorId=await url.getAttribute('aria-describedby');expect(errorId).toBeTruthy();await expect(page.locator(`[id="${errorId}"]`)).not.toBeEmpty();await expect(name).toHaveValue('Synthetic workflow retained');
 await shot(page,testInfo,'dialog-field-correction');await url.fill('https://n8n.example.invalid/workflow/synthetic');await expect(url).not.toHaveAttribute('aria-invalid','true');
 await page.route('**/api/action',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic save unavailable. Try again.'})}));
 await dialog.getByRole('button',{name:'Connect workflow',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Synthetic save unavailable');await expect(name).toHaveValue('Synthetic workflow retained');await expect(url).toHaveValue('https://n8n.example.invalid/workflow/synthetic');
 await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
 await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('button',{name:'Add selected links',exact:true}).click();const input=page.getByLabel('Job links or CSV',{exact:true});await expect(input).toBeFocused();const hintId=await input.getAttribute('aria-describedby');await expect(page.locator(`[id="${hintId}"]`)).toContainText('One URL per line');await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Add selected links',exact:true})).toBeFocused();
});

test('document approvals require the current reviewable application and receipt state',async({page},testInfo)=>{
 const ctx=hub.context(false),store=ctx.store;let job={id:'experience-review',identity:'experience:review',title:'Synthetic review role',employer:'Synthetic Experience Lab',url:'https://fixture.example.invalid/review',state:'needs_you',packageId:'experience-current',revision:0,posting:{sourceHash:'experience-review-source',text:'Synthetic isolated source for current-package review.'}};store.put('job',job);const observation=ctx.engine.postings.record(job,job.posting,{adopt:true});job=store.get('job',job.id);const pkg={id:'experience-current',jobId:'experience-review',postingBinding:ctx.engine.postings.binding(job,observation),verified:true,approved:false,hash:'synthetic-hash',text:'Synthetic document',profileRevision:store.get('profile','main').updatedAt};
 store.put('package',pkg);store.put('decision',{id:'experience-review-question',jobId:job.id,code:'package_review',type:'package_review',state:'open',title:'Review the exact synthetic document',question:'Approve this exact retained version?',options:[{value:'approve',label:'Approve exact document'}]});await refresh(page);
 await page.getByRole('button',{name:'Needs You',exact:true}).click();await expect(page.getByRole('heading',{name:/^Needs You/})).toBeFocused();await shot(page,testInfo,'needs-you');
 await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('button',{name:/^(Open workspace|Open application queue|Review paused campaign)$/}).click();await page.locator('.application-row').click();const approval=page.getByRole('button',{name:'Approve this document',exact:true});await expect(approval).toBeEnabled();
 const cases=[{state:'ready',allowed:true},{state:'imported'},{state:'failed'},{state:'cancelled'},{state:'needs_you',priorApplicationDetected:true},{state:'ready',submissionConfirmation:'employer_confirmed'},{state:'ready',submissionConfirmation:'candidate_attested'},{state:'ready',submissionConfirmation:'fixture'},{state:'needs_you',latestPostingObservationId:'newer-observed-source'},{state:'needs_you',packageId:'experience-newer',absent:true}];
 for(const change of cases){const {allowed,absent,...fields}=change;store.put('job',{...job,...fields});await refresh(page);if(allowed)await expect(approval).toBeEnabled();else if(absent){await expect(approval).toHaveCount(0);await expect(page.getByRole('heading',{name:'No document prepared',exact:true})).toBeVisible();}else await expect(approval).toBeDisabled();}
 store.put('job',job);store.put('package',{...pkg,postingBinding:undefined});await refresh(page);await expect(approval).toBeDisabled();store.put('package',{...pkg,profileRevision:'previous-candidate-revision'});await refresh(page);await expect(approval).toBeDisabled();store.put('package',{...pkg,jobId:'another-synthetic-role'});await refresh(page);await expect(approval).toBeDisabled();
});
