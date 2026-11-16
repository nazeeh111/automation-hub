import {test,expect} from '@playwright/test';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

let hub,directory,external,errors;
const output={chosenResumeId:'synthetic-resume',edits:[],structureEdits:[],requirements:[],questions:[]};
test.beforeEach(async({page})=>{
 directory=await mkdtemp(path.join(tmpdir(),'hub-reasoning-ui-'));
 hub=await createHub({directory,port:0,open:false,modelRunner:async()=>output,discoveryOptions:{fetcher:async()=>{throw new Error('No external fixture request');}}});external=[];errors=[];
 await page.context().route('**/*',route=>{if(new URL(route.request().url()).origin!==hub.baseUrl){external.push(route.request().url());return route.abort('blockedbyclient');}return route.continue();});
 page.on('pageerror',e=>errors.push(e.message));await page.goto(hub.launchUrl);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();await hub.context(false).engine.stop({releaseWorker:false});
});
test.afterEach(async({page})=>{await page.close();await hub.close();await rm(directory,{recursive:true,force:true});expect(external).toEqual([]);expect(errors).toEqual([]);});
const refresh=async page=>{const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/state');await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await (await response).finished();};
async function find(page,query){await page.getByRole('button',{name:'Find in your workspace',exact:true}).click();await page.getByRole('combobox',{name:'Find a page, application or question',exact:true}).fill(query);await page.keyboard.press('Enter');}
async function screenshot(page,testInfo,name){const dir=path.resolve('docs/ai-automation-pass-2026-11-16/root/renders');await mkdir(dir,{recursive:true});await page.screenshot({path:path.join(dir,`${testInfo.project.name}-${name}.png`),fullPage:false});}

test('AI allowance, failures and setup destinations stay visible without triggering another request',async({page},testInfo)=>{
 const ctx=hub.context(false),store=ctx.store;store.put('connection',{id:'model',enabled:true,verified:true});
 await ctx.model.reason({privatePrompt:'SYNTHETIC_PRIVATE_INPUT'});ctx.model.runner=async()=>{throw new Error('SYNTHETIC_PRIVATE_ERROR');};await expect(ctx.model.draftWriting({})).rejects.toThrow('SYNTHETIC_PRIVATE_ERROR');
 await refresh(page);await find(page,'connections');await expect(page.getByRole('heading',{name:'Connections',exact:true})).toBeVisible();
 const activity=page.getByRole('region',{name:'Reasoning activity',exact:true});await expect(activity).toContainText('2 of 20 calls reserved');await expect(activity).toContainText('18 remaining');await expect(activity).toContainText('Answer draft failed');await expect(activity).not.toContainText('SYNTHETIC_PRIVATE');
 await activity.getByText('Recent reasoning requests (2)',{exact:true}).click();await expect(activity).toContainText('Output returned');await expect(activity).toContainText('Failed');await screenshot(page,testInfo,'reasoning-failure');
 await activity.getByRole('button',{name:'Review reasoning connection',exact:true}).click();await expect(page.getByRole('dialog',{name:'Application reasoning connection'})).toBeVisible();await page.keyboard.press('Escape');
 await activity.getByRole('button',{name:'Review call limit',exact:true}).click();await expect(page.getByRole('dialog',{name:'Campaign rules'})).toBeVisible();await page.keyboard.press('Escape');
 await find(page,'automations');await expect(page.getByRole('heading',{name:'Your automations',exact:true})).toBeVisible();expect(store.get('usage','model').calls).toBe(2);expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('run')).toHaveLength(0);
});

test('live request and legacy usage distinguish progress, interruption and exhausted allowance',async({page},testInfo)=>{
 const ctx=hub.context(false),store=ctx.store;store.put('connection',{id:'model',enabled:true,verified:true});
 let release;ctx.model.runner=()=>new Promise(resolve=>release=resolve);const pending=ctx.model.reason({});
 await refresh(page);await find(page,'connections');const activity=page.getByRole('region',{name:'Reasoning activity'});await expect(activity).toContainText('Request in progress');await expect(activity).toContainText('1 of 20 calls reserved');
 release(output);await pending;await refresh(page);await expect(activity).toContainText('No request in progress');
 store.put('usage',{id:'model',calls:12});store.put('campaign',{...store.get('campaign','main'),rules:{...store.get('campaign','main').rules,maxReasoningCalls:10}});await refresh(page);await expect(activity).toContainText('12 of 10 calls reserved');await expect(activity).toContainText('0 remaining');await activity.getByText('Recent reasoning requests',{exact:true}).click();await expect(activity).toContainText('Earlier aggregate usage is preserved without invented history');
 for(const width of [1440,768,390,320]){await page.setViewportSize({width,height:900});await expect(activity).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await activity.getByRole('button',{name:'Review call limit'}).focus();await expect(activity.getByRole('button',{name:'Review call limit'})).toBeFocused();if(width===320)await screenshot(page,testInfo,'reasoning-mobile');}
 store.put('usage',{id:'model',calls:-1});await refresh(page);await expect(activity).toContainText('Usage unavailable');await expect(activity).toContainText('The saved usage count needs review');await expect(activity.getByRole('meter')).toHaveCount(0);
});

test('observed n8n activation and failed execution stay distinct and never activate recovery',async({page},testInfo)=>{
 const store=hub.context(false).store,at=new Date().toISOString();
 store.put('automation',{id:'external-fixture',executor:'n8n',name:'Synthetic research digest',scheduleOwner:'n8n',externalUrl:'https://example.invalid/workflow/research',observationStatus:'observed',lastObservedAt:at,observation:{observedAt:at,workflow:{name:'Synthetic research digest',active:true},executions:[{id:'fixture-error',status:'error',startedAt:at,stoppedAt:at}]}});
 await refresh(page);const home=page.locator('.external-automation');await expect(home).toContainText('Active in n8n');await expect(home.locator('.n8n-outcome')).toContainText('Last observed execution');await expect(home.locator('.n8n-outcome')).toContainText('Error');
 await find(page,'automations');const card=page.locator('.external-workflow');await expect(card).toContainText('Active in n8n');await expect(card.locator('.n8n-outcome')).toContainText('Error');await screenshot(page,testInfo,'workflow-outcome');
 const previous=store.get('automation','external-fixture');store.put('automation',{...previous,observation:{...previous.observation,observedAt:new Date(Date.now()-6*60000).toISOString()}});await refresh(page);await expect(card).toContainText('Stale observation');await expect(card.locator('.n8n-outcome')).toContainText('From an earlier observation');expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('run')).toHaveLength(0);
});
