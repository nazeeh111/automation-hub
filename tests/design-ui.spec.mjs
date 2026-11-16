import {test,expect} from '@playwright/test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';
import {parseDiscoverySource} from '../server/job-discovery.mjs';

test.use({viewport:{width:1440,height:1000}});
let hub,directory;
function populate(){
 const store=hub.context(false).store,source=parseDiscoverySource('https://job-boards.greenhouse.io/synthetic-design-lab'),observed=new Date().toISOString();
 store.put('discovery_source',{...source,label:'Synthetic Design Lab',status:'ready',coverage:'complete',lastObservedAt:observed,lastAttemptAt:observed,jobCount:61,revision:1});
 for(let index=0;index<61;index++)store.put('discovery_candidate',{id:`${source.id}:design-${String(index).padStart(3,'0')}`,sourceId:source.id,provider:'greenhouse',region:'us',externalId:`design-${index}`,company:'Synthetic Design Lab',title:`Electrical engineering intern ${String(index).padStart(3,'0')}`,location:'Blacksburg, Virginia',locationScope:'us',employmentType:'internship',department:'Engineering',workplaceType:'hybrid',description:'Synthetic design verification fixture. Engineering requirements remain in the source posting.',url:`https://job-boards.greenhouse.io/synthetic-design-lab/jobs/${index+1}`,canonicalUrl:`https://job-boards.greenhouse.io/synthetic-design-lab/jobs/${index+1}`,postedAt:null,firstSeenAt:observed,lastSeenAt:observed,availability:'active',supportStatus:'portal_review_required'});
 return store;
}
test.beforeEach(async({page})=>{
 await page.addInitScript(()=>{const schedule=window.setInterval;window.setInterval=(callback,delay,...args)=>schedule(delay===5000?()=>{}:callback,delay,...args);});
 directory=await mkdtemp(path.join(tmpdir(),'hub-workbench-design-'));hub=await createHub({directory,port:0,open:false});populate();await page.goto(hub.launchUrl);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
});
test.afterEach(async({page})=>{await page.close();await hub?.close();await rm(directory,{recursive:true,force:true});});
const discover=async page=>{await page.getByRole('button',{name:'Open workspace',exact:true}).click();await page.locator('#workspace-tab-discover').click();await expect(page.locator('.jd-job-card')).toHaveCount(40);};
const paint=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function measure(page){return page.evaluate(()=>{
 const visible=element=>{const box=element.getBoundingClientRect(),style=getComputedStyle(element);return box.width>0&&box.height>0&&style.visibility!=='hidden'&&style.display!=='none';};
 const controls=[...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,summary,[role=tab]')].filter(visible).map(element=>{const box=element.getBoundingClientRect(),style=getComputedStyle(element);return {name:element.getAttribute('aria-label')||element.textContent.trim().slice(0,90),width:box.width,height:box.height,fontSize:style.fontSize};});
 return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,scrollY,headings:[...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0,16).map(element=>({level:element.tagName,text:element.textContent,top:element.getBoundingClientRect().top})),undersized44:controls.filter(item=>item.width<43.99||item.height<43.99),undersized24:controls.filter(item=>item.width<23.99||item.height<23.99),controlCount:controls.length};
 });}

if(process.env.HUB_DESIGN_BASELINE==='1'){
 test('capture v9 source-driven design baseline and navigation defect',async({page},testInfo)=>{
  await page.screenshot({path:testInfo.outputPath('home-before.png'),fullPage:true});const home=await measure(page);
  await discover(page);await page.screenshot({path:testInfo.outputPath('discover-before.png')});const discovery=await measure(page);
  await page.evaluate(()=>window.scrollTo(0,1400));await page.getByRole('button',{name:'Home',exact:true}).click();await paint(page);const inherited=await measure(page);
  expect(inherited.scrollY).toBeGreaterThan(200);
  await page.screenshot({path:testInfo.outputPath('home-inherited-scroll-before.png')});
  await writeFile(testInfo.outputPath('audit-before.json'),JSON.stringify({home,discovery,inheritedNavigation:inherited},null,2));
 });
}else{
 test('Home connects observed roles to the peer map and truthful application flow',async({page},testInfo)=>{
  await expect(page.locator('.home-discovery-lead')).toContainText('61');
  await expect(page.locator('.home-discovery-lead')).toContainText('US internships');
  await expect(page.locator('.flow-inputs')).toContainText('0 selected roles');await expect(page.locator('.flow-receipt')).toContainText('0 confirmed');
  await expect(page.locator('.workflow-links')).toBeVisible();await expect(page.locator('.registry-node')).toHaveCount(1);
  await page.screenshot({path:testInfo.outputPath('home-after.png'),fullPage:true});await writeFile(testInfo.outputPath('audit-home-after.json'),JSON.stringify(await measure(page),null,2));
  await page.setViewportSize({width:320,height:844});await page.locator('.flow-outcomes').focus();await page.keyboard.press('Tab');await expect(page.locator('.hub-flow-review')).toBeFocused();const review=await page.locator('.hub-flow-review').boundingBox(),frame=await page.locator('.hub-flow-scroll').boundingBox();expect(review.x).toBeGreaterThanOrEqual(frame.x-1);expect(review.x+review.width).toBeLessThanOrEqual(frame.x+frame.width+1);expect(review.y+review.height).toBeLessThanOrEqual(frame.y+frame.height+1);await page.screenshot({path:testInfo.outputPath('home-review-320-after.png')});await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>window.scrollTo(0,0));
  await page.getByRole('button',{name:'Browse US internships',exact:true}).click();await expect(page.locator('#workspace-tab-discover')).toHaveAttribute('aria-selected','true');await expect(page.locator('.jd-job-card')).toHaveCount(40);
  expect(hub.context(false).store.list('job')).toHaveLength(0);expect(hub.context(false).store.get('campaign','main').enabled).toBe(false);
  hub.context(false).store.put('job',{id:'design-selected-queue',title:'Synthetic selected role',employer:'Synthetic Design Lab',url:'https://fixture.example.invalid/design/selected',state:'imported',nextAction:'Read the exact saved posting'});await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await page.getByRole('button',{name:'Home',exact:true}).click();await expect(page.locator('.home-discovery-lead')).toContainText('Read the exact saved posting');await page.locator('.home-discovery-lead').getByRole('button',{name:'Open application queue',exact:true}).click();await expect(page.locator('#workspace-tab-applications')).toHaveAttribute('aria-selected','true');await expect(page.locator('.application-row')).toContainText('Synthetic selected role');
 });
 test('page navigation resets position and heading focus without stealing tab focus',async({page},testInfo)=>{
  await discover(page);await page.evaluate(()=>window.scrollTo(0,1400));await page.getByRole('button',{name:'Home',exact:true}).click();await paint(page);
  expect(await page.evaluate(()=>scrollY)).toBe(0);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Open workspace',exact:true}).click();const resumes=page.locator('#workspace-tab-resumes');await resumes.click();await page.keyboard.press('ArrowRight');await expect(page.locator('#workspace-tab-outcomes')).toBeFocused();await expect(page.locator('#workspace-tab-outcomes')).toHaveAttribute('aria-selected','true');
  await page.screenshot({path:testInfo.outputPath('navigation-focus-after.png')});
 });
 test('workbench feed uses the width, preserves source evidence and fits responsive layouts',async({page},testInfo)=>{
  await discover(page);const first=page.locator('.jd-job-card').first();const bounds=await first.boundingBox();expect(bounds.y).toBeLessThan(430);expect(bounds.width).toBeGreaterThan(1000);
  await page.screenshot({path:testInfo.outputPath('discover-after.png')});await writeFile(testInfo.outputPath('audit-discover-after.json'),JSON.stringify(await measure(page),null,2));
  await first.getByRole('button',{name:/^Details for/}).click();await expect(page.getByRole('region',{name:'Job details'})).toContainText('Date not supplied by source');await expect(page.getByRole('button',{name:'Add to application queue',exact:true})).toBeVisible();await page.screenshot({path:testInfo.outputPath('role-after.png')});await page.getByRole('button',{name:'Close job details',exact:true}).click();
  for(const width of [768,390,320]){await page.setViewportSize({width,height:900});await page.evaluate(()=>window.scrollTo(0,0));await paint(page);expect((await measure(page)).documentWidth).toBeLessThanOrEqual(width);await page.screenshot({path:testInfo.outputPath(`discover-${width}-after.png`)});}
 });
 test('question drafts survive navigation and are dropped when their source context changes',async({page})=>{
  const store=hub.context(false).store;
  store.put('job',{id:'design-question-job',url:'https://fixture.example.invalid/design/role',title:'Synthetic question role',employer:'Synthetic Design Lab',state:'needs_you',posting:{sourceHash:'synthetic-design-posting'},answers:{}});
  store.put('decision',{id:'design-question',jobId:'design-question-job',type:'missing_fact',state:'open',title:'Confirm a candidate fact',question:'What should this exact employer use?'});
  await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await page.locator('.home-discovery-lead').getByRole('button',{name:'Review Needs You',exact:true}).click();
  await page.getByLabel('Your answer',{exact:true}).fill('Synthetic draft retained only in this workspace context');
  await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('button',{name:'Needs You',exact:true}).click();
  await expect(page.getByLabel('Your answer',{exact:true})).toHaveValue('Synthetic draft retained only in this workspace context');
  store.put('profile',{...store.get('profile','main'),fullName:'Corrected Synthetic Candidate'});await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
  await expect(page.getByLabel('Your answer',{exact:true})).toHaveValue('');
  expect(store.get('decision','design-question').state).toBe('open');
  store.put('decision',{id:'design-eligibility',jobId:'design-question-job',type:'eligibility_review',code:'eligibility_review',state:'open',title:'Review synthetic eligibility',details:{requirements:[{id:'design-requirement',quote:'Currently enrolled in an engineering degree',binding:'synthetic-requirement-v1'}]}});await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
  await page.getByRole('radio',{name:'Eligible',exact:true}).check();await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('button',{name:'Needs You',exact:true}).click();await expect(page.getByRole('radio',{name:'Eligible',exact:true})).toBeChecked();
  const eligibility=store.get('decision','design-eligibility');store.put('decision',{...eligibility,details:{requirements:[{...eligibility.details.requirements[0],quote:'Revised exact employer eligibility requirement',binding:'synthetic-requirement-v2'}]}});await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await expect(page.getByRole('radio',{name:'Eligible',exact:true})).not.toBeChecked();
 });
 test('renderer readiness acknowledges a committed loaded or recovery view only',async({page})=>{
  // This uses a synthetic page bridge, never a real native window or account.
  await page.addInitScript(()=>{Object.defineProperty(window,'__hubLaunchGeneration',{value:'synthetic-design-generation'});window.syntheticReadyMessages=[];window.webkit={messageHandlers:{hub:{postMessage:message=>window.syntheticReadyMessages.push({...message,committedView:Boolean(document.querySelector('.hub-home')||document.querySelector('.offline-banner'))})}}};});
  await page.reload();await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();await expect.poll(()=>page.evaluate(()=>window.syntheticReadyMessages.filter(message=>message.action==='workspaceReady').length)).toBeGreaterThan(0);expect(await page.evaluate(()=>window.syntheticReadyMessages.every(message=>message.action!=='workspaceReady'||(message.generation==='synthetic-design-generation'&&message.committedView===true)))).toBe(true);
 });
}
