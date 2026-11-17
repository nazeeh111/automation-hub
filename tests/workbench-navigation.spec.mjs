import {navigateTo,workspaceSection,openNavigation,closeNavigation} from './navigation-helper.mjs';
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
 const choices=page.getByRole('navigation',{name:'Choose a saved question',exact:true});await expect(choices.getByRole('button')).toHaveCount(4);await choices.locator('[data-question-id="question-1"]').click();await expect(page.locator('[data-attention-id="question-1"] h2')).toBeFocused();await shot(page,testInfo,'decision-index');
 expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('run')).toHaveLength(0);expect(store.list('decision').filter(item=>item.state==='open')).toHaveLength(4);
});

test('keyboard search wraps, restores focus and respects an existing edit dialog',async({page})=>{
 const trigger=page.getByRole('button',{name:'Find in your workspace',exact:true});await trigger.focus();await page.keyboard.press('Control+k');await expect(search(page)).toBeFocused();await page.keyboard.press('ArrowUp');await expect(page.locator('.quick-open').getByRole('option').last()).toHaveAttribute('aria-selected','true');await page.keyboard.press('ArrowDown');await expect(page.locator('.quick-open').getByRole('option').first()).toHaveAttribute('aria-selected','true');await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
 await page.getByRole('button',{name:'Add selected links',exact:true}).click();const links=page.getByLabel('Job links or CSV',{exact:true});await links.fill('https://job-boards.greenhouse.io/example/jobs/123');await page.keyboard.press('Control+k');await expect(page.getByRole('dialog',{name:'Find in your workspace'})).toHaveCount(0);await expect(links).toHaveValue('https://job-boards.greenhouse.io/example/jobs/123');await page.keyboard.press('Escape');
 await open(page);await search(page).fill('resume');await expect(page.getByRole('option',{name:/Résumé library/})).toBeVisible();await page.keyboard.press('Enter');await expect(page.locator('#workspace-tab-resumes')).toHaveAttribute('aria-selected','true');
});

test('workflow stages open real destinations and mobile layouts keep controls reachable',async({page},testInfo)=>{
 const guide=page.locator('.home-workflow-guide');
 for(const [name,tab] of [['Select roles','discover'],['Check requirements','applications'],['Prepare résumé','resumes'],['Apply','applications'],['Confirm receipt','outcomes']]){
  await expect(guide).not.toHaveAttribute('open','');await guide.locator('summary').focus();await page.keyboard.press('Enter');await expect(guide).toHaveAttribute('open','');
  await page.getByRole('button',{name:`Open step: ${name}`,exact:true}).click();await expect(page.locator(`#workspace-tab-${tab}`)).toHaveAttribute('aria-selected','true');await navigateTo(page,'Home');
 }
 for(const width of [1440,1000,768,390,320]){
  await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  const context=page.locator('#hub-navigation'),trigger=page.getByRole('button',{name:'Open navigation',exact:true});await expect(context).toHaveCount(1);
  if(width<1100){await expect(context).toBeHidden();await expect(trigger).toBeVisible();await openNavigation(page);await expect(context).toHaveAttribute('aria-modal','true');}else{await expect(context).toBeVisible();await expect(trigger).toBeHidden();}
  const global=page.getByRole('navigation',{name:'Main navigation',exact:true});await expect(global.getByRole('button')).toHaveCount(3);expect(await global.getByRole('button').allTextContents()).toEqual(['Home','Automations','Needs You']);
  const navBounds=await global.boundingBox(),buttons=await global.getByRole('button').all();let previousBottom=navBounds.y;
  for(const button of buttons){const box=await button.boundingBox();expect(box.width).toBeGreaterThan(0);expect(box.height).toBeGreaterThanOrEqual(width<1100?44:36);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);expect(box.y).toBeGreaterThanOrEqual(previousBottom);expect(box.y+box.height).toBeLessThanOrEqual(navBounds.y+navBounds.height+1);previousBottom=box.y+box.height;}
  const tabs=context.getByRole('tab');await expect(tabs).toHaveCount(5);for(const tab of await tabs.all()){await expect(tab).toBeVisible();const bound=await tab.boundingBox(),box=await context.boundingBox();expect(bound.x).toBeGreaterThanOrEqual(box.x);expect(bound.x+bound.width).toBeLessThanOrEqual(box.x+box.width);expect(bound.y).toBeGreaterThanOrEqual(box.y);expect(bound.y+bound.height).toBeLessThanOrEqual(box.y+box.height);}
  await closeNavigation(page);await page.getByRole('button',{name:'Go to Applications',exact:true}).click();await workspaceSection(page,'settings');if(width<1100)await expect(page.getByRole('heading',{name:'Workspace setup',exact:true})).toBeFocused();else await expect(page.locator('#workspace-tab-settings')).toBeFocused();await expect(page.locator('#workspace-tab-settings')).toHaveAttribute('aria-selected','true');
  if(width<1100){await expect(context).toBeHidden();await openNavigation(page);const last=context.getByRole('button',{name:'Open Connections',exact:true});await last.focus();await page.keyboard.press('Tab');await expect(context.getByRole('button',{name:'Automation hub home',exact:true})).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(last).toBeFocused();await closeNavigation(page);}
  await navigateTo(page,'Home');await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeFocused();await open(page);await search(page).fill('zz-no-such-role');await expect(page.locator('.quick-open-footer')).toContainText('No matches');await page.keyboard.press('Enter');await expect(search(page)).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await shot(page,testInfo,`quick-empty-${width}`);await page.keyboard.press('Escape');
 }
 expect(hub.context(false).store.get('campaign','main').enabled).toBe(false);
});

test('search closes when the workspace cannot be confirmed and never navigates stale results',async({page})=>{
 await open(page);await search(page).fill('application queue');await page.route('**/api/state',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic connection loss'})}));await page.evaluate(()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await page.getByRole('button',{name:'Refresh dashboard',exact:true}).evaluate(element=>element.click());await expect(page.getByRole('dialog',{name:'Find in your workspace'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Find in your workspace',exact:true})).toBeDisabled();await expect(page.locator('.offline-banner')).toContainText('Changes are paused');expect(hub.context(false).store.get('campaign','main').enabled).toBe(false);
});


test('Ashby discovery reads a public snapshot, saves and selects one role without submitting',async({page},testInfo)=>{
 const id='00000000-0000-4000-8000-000000000001';
 discoveryPayload={apiVersion:'1',jobs:[{id,title:'Controls engineering placement',location:'Boston, MA',address:{postalAddress:{addressCountry:'USA'}},employmentType:'Intern',workplaceType:'Hybrid',isRemote:true,isListed:true,descriptionPlain:'A synthetic internship. Python and simulation preferred.',publishedAt:'2026-11-16T12:00:00Z',jobUrl:`https://jobs.ashbyhq.com/example/${id}`,applyUrl:`https://jobs.ashbyhq.com/example/${id}/application`}]};
 await page.locator('.home-next-actions').getByRole('button',{name:'Browse US internships',exact:true}).click();
 await page.getByLabel('Employer job board URL',{exact:true}).fill('https://jobs.ashbyhq.com/example');await page.getByLabel('Source company name',{exact:true}).fill('Example Controls');await page.getByRole('button',{name:'Add source',exact:true}).click();await page.getByRole('button',{name:'Check jobs',exact:true}).click();
 await expect(page.locator('.jd-job-card')).toHaveCount(1);await page.getByRole('button',{name:'Details for Controls engineering placement at Example Controls',exact:true}).click();const detail=page.getByRole('region',{name:'Job details'});await expect(detail).toContainText('Hybrid');await detail.getByText('Source and observation',{exact:true}).click();await expect(detail).toContainText('Last published');await detail.getByText('Application route',{exact:true}).click();await expect(detail).toContainText('manual completion');await detail.getByRole('button',{name:'Save for later',exact:true}).click();await expect(detail.getByRole('button',{name:'Saved',exact:true})).toHaveAttribute('aria-pressed','true');await detail.getByRole('button',{name:'Add to application queue',exact:true}).click();await expect(detail.getByRole('button',{name:'In application queue',exact:true})).toBeVisible();await page.screenshot({path:testInfo.outputPath('ashby-detail.png'),fullPage:true});await detail.getByRole('button',{name:'In application queue',exact:true}).click();await expect(page.locator('.application-inspector')).toContainText('Controls engineering placement');
 const store=hub.context(false).store;expect(store.list('job')).toHaveLength(1);expect(store.list('run')).toHaveLength(0);expect(store.list('discovery_favorite')[0].favorite).toBe(true);expect(store.get('campaign','main').enabled).toBe(false);
});
