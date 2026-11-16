import {test,expect} from '@playwright/test';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';
let hub,directory,errors,discoveryPayload;
const evidence=path.resolve('docs/competitive-pass-2026-11-16/root/navigation-results');
test.beforeEach(async({page})=>{
 directory=await mkdtemp(path.join(tmpdir(),'hub-navigation-'));
 discoveryPayload=null;hub=await createHub({directory,port:0,open:false,dev:process.env.HUB_NAV_DEV==='1',discoveryOptions:{resolver:async()=>[{address:'93.184.216.34',family:4}],fetcher:async()=>{if(!discoveryPayload)throw new Error('No external fetch in navigation tests');return new Response(JSON.stringify(discoveryPayload));}}});errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(hub.launchUrl);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();await hub.context(false).engine.stop({releaseWorker:false});
});
test.afterEach(async({page})=>{expect(errors).toEqual([]);await page.close();await hub.close();await rm(directory,{recursive:true,force:true});});
const refresh=async page=>{const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/state');await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await (await response).finished();};
const open=async page=>{await page.getByRole('button',{name:'Find in your workspace',exact:true}).click();await expect(page.getByRole('dialog',{name:'Find in your workspace'})).toBeVisible();};
const search=page=>page.getByRole('combobox',{name:'Find a page, application or question',exact:true});
async function shot(page,testInfo,name){await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${testInfo.project.name}-${name}.png`),fullPage:true});}

test('quick navigation opens exact retained application and question with purposeful focus',async({page},testInfo)=>{
 const store=hub.context(false).store;
 for(let index=0;index<75;index++)store.put('job',{id:`nav-${index}`,title:`Engineering internship ${index}`,employer:`Example employer ${index}`,url:`https://fixture.example.invalid/nav/${index}`,state:'imported',nextAction:'Read this saved posting',revision:0});
 for(let index=0;index<4;index++)store.put('decision',{id:`question-${index}`,jobId:`nav-${index}`,code:'account_access',title:`Review access for example ${index}`,reason:'Review the saved access requirement',state:'open'});
 await refresh(page);await open(page);await expect(search(page)).toBeFocused();await expect(page.locator('.quick-open').getByRole('option')).toHaveCount(30);await expect(page.locator('.quick-open-footer')).toContainText('Keep typing');
 await search(page).fill('internship 47');await expect(page.locator('.quick-open').getByRole('option')).toHaveCount(1);await shot(page,testInfo,'quick-find-application');await page.keyboard.press('Enter');
 await expect(page.getByRole('dialog',{name:'Find in your workspace'})).toHaveCount(0);const inspector=page.locator('.application-inspector');await expect(inspector).toContainText('Engineering internship 47');await expect(inspector.locator('h2')).toBeFocused();
 await page.keyboard.press('Escape');await expect(page.locator('[data-job-id="nav-47"]')).toBeFocused();await open(page);await search(page).fill('access example 3');await expect(page.locator('.quick-open').getByRole('option')).toHaveCount(1);await page.keyboard.press('Enter');await expect(page.locator('[data-attention-id="question-3"] h2')).toBeFocused();
 await expect(page.getByLabel('Jump to a saved question',{exact:true})).toBeVisible();await page.getByLabel('Jump to a saved question',{exact:true}).selectOption('question-1');await expect(page.locator('[data-attention-id="question-1"] h2')).toBeFocused();await shot(page,testInfo,'decision-index');
 expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('run')).toHaveLength(0);expect(store.list('decision').filter(item=>item.state==='open')).toHaveLength(4);
});

test('keyboard search wraps, restores focus and respects an existing edit dialog',async({page})=>{
 const trigger=page.getByRole('button',{name:'Find in your workspace',exact:true});await trigger.focus();await page.keyboard.press('Control+k');await expect(search(page)).toBeFocused();await page.keyboard.press('ArrowUp');await expect(page.locator('.quick-open').getByRole('option').last()).toHaveAttribute('aria-selected','true');await page.keyboard.press('ArrowDown');await expect(page.locator('.quick-open').getByRole('option').first()).toHaveAttribute('aria-selected','true');await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
 await page.getByRole('button',{name:'Add selected links',exact:true}).click();const links=page.getByLabel('Job links or CSV',{exact:true});await links.fill('https://job-boards.greenhouse.io/example/jobs/123');await page.keyboard.press('Control+k');await expect(page.getByRole('dialog',{name:'Find in your workspace'})).toHaveCount(0);await expect(links).toHaveValue('https://job-boards.greenhouse.io/example/jobs/123');await page.keyboard.press('Escape');
 await open(page);await search(page).fill('resume');await expect(page.getByRole('option',{name:/Résumé library/})).toBeVisible();await page.keyboard.press('Enter');await expect(page.getByRole('tab',{name:/Resumes/})).toHaveAttribute('aria-selected','true');
});

test('workflow stages open real destinations and mobile layouts keep controls reachable',async({page},testInfo)=>{
 for(const [name,tab] of [['Select roles','Discover'],['Check requirements','Applications'],['Prepare résumé','Resumes'],['Apply','Applications'],['Confirm receipt','Outcomes']]){await page.getByRole('button',{name:`Open step: ${name}`,exact:true}).click();await expect(page.getByRole('tab',{name:new RegExp(`^${tab}`)})).toHaveAttribute('aria-selected','true');await page.getByRole('button',{name:'Home',exact:true}).click();}
 for(const width of [1440,1000,768,390,320]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if(width===768||width===1000){const rail=await page.locator('.sidebar').boundingBox();expect(rail.x).toBe(0);expect(rail.y).toBe(0);expect(rail.width).toBe(80);expect(rail.height).toBe(900);const buttons=await page.locator('.sidebar nav .nav-item').all();for(const button of buttons){const box=await button.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(80);expect(box.y+box.height).toBeLessThan(450);}}await open(page);await search(page).fill('zz-no-such-role');await expect(page.locator('.quick-open-footer')).toContainText('No matches');await page.keyboard.press('Enter');await expect(search(page)).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot(page,testInfo,`quick-empty-${width}`);await page.keyboard.press('Escape');}
 expect(hub.context(false).store.get('campaign','main').enabled).toBe(false);
});

test('search closes when the workspace cannot be confirmed and never navigates stale results',async({page})=>{
 await open(page);await search(page).fill('application queue');await page.route('**/api/state',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic connection loss'})}));await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await page.getByRole('button',{name:'Refresh dashboard',exact:true}).evaluate(element=>element.click());await expect(page.getByRole('dialog',{name:'Find in your workspace'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Find in your workspace',exact:true})).toBeDisabled();await expect(page.locator('.offline-banner')).toContainText('Changes are paused');expect(hub.context(false).store.get('campaign','main').enabled).toBe(false);
});


test('Ashby discovery reads a public snapshot, saves and selects one role without submitting',async({page},testInfo)=>{
 const id='00000000-0000-4000-8000-000000000001';
 discoveryPayload={apiVersion:'1',jobs:[{id,title:'Controls engineering placement',location:'Boston, MA',address:{postalAddress:{addressCountry:'USA'}},employmentType:'Intern',workplaceType:'Hybrid',isRemote:true,isListed:true,descriptionPlain:'A synthetic internship. Python and simulation preferred.',publishedAt:'2026-11-16T12:00:00Z',jobUrl:`https://jobs.ashbyhq.com/example/${id}`,applyUrl:`https://jobs.ashbyhq.com/example/${id}/application`}]};
 await page.getByRole('button',{name:'Browse US internships',exact:true}).click();
 await page.getByLabel('Employer job board URL',{exact:true}).fill('https://jobs.ashbyhq.com/example');await page.getByLabel('Source company name',{exact:true}).fill('Example Controls');await page.getByRole('button',{name:'Add source',exact:true}).click();await page.getByRole('button',{name:'Check jobs',exact:true}).click();
 await expect(page.locator('.jd-job-card')).toHaveCount(1);await page.getByRole('button',{name:'Details for Controls engineering placement at Example Controls',exact:true}).click();const detail=page.getByRole('region',{name:'Job details'});await expect(detail).toContainText('Hybrid');await detail.getByText('Source and observation',{exact:true}).click();await expect(detail).toContainText('Last published');await detail.getByText('Application route',{exact:true}).click();await expect(detail).toContainText('manual completion');await detail.getByRole('button',{name:'Save for later',exact:true}).click();await expect(detail.getByRole('button',{name:'Saved',exact:true})).toHaveAttribute('aria-pressed','true');await detail.getByRole('button',{name:'Add to application queue',exact:true}).click();await expect(detail.getByRole('button',{name:'In application queue',exact:true})).toBeVisible();await page.screenshot({path:testInfo.outputPath('ashby-detail.png'),fullPage:true});await detail.getByRole('button',{name:'In application queue',exact:true}).click();await expect(page.locator('.application-inspector')).toContainText('Controls engineering placement');
 const store=hub.context(false).store;expect(store.list('job')).toHaveLength(1);expect(store.list('run')).toHaveLength(0);expect(store.list('discovery_favorite')[0].favorite).toBe(true);expect(store.get('campaign','main').enabled).toBe(false);
});
