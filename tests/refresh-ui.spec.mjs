import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';
let hub,directory;
test.beforeEach(async({page})=>{await page.addInitScript(()=>{const schedule=window.setInterval;window.setInterval=(callback,delay,...args)=>schedule(delay===5000?()=>{}:callback,delay,...args);});directory=await mkdtemp(path.join(tmpdir(),'hub-refresh-audit-'));hub=await createHub({directory,port:0});await page.goto(hub.launchUrl);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();await page.getByRole('button',{name:'Internships',exact:true}).click();await page.getByRole('tab',{name:'Settings',exact:true}).click();});
test.afterEach(async({page})=>{await page.close();await hub?.close();await rm(directory,{recursive:true,force:true});});
const painted=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
test('late real-state response cannot replace a newly selected fixture workspace',async({page},testInfo)=>{
 let holdNext=true,release,received,delivered;const held=new Promise(r=>received=r),gate=new Promise(r=>release=r),done=new Promise(r=>delivered=r);
 await page.route('**/api/state',async route=>{if(holdNext){holdNext=false;const headers={...route.request().headers()};delete headers['if-none-match'];const response=await route.fetch({headers});expect((await response.json()).demo).toBe(false);received();await gate;await route.fulfill({response});delivered();}else await route.continue();});
 await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await held;
 await page.getByRole('button',{name:'Open fixture workspace',exact:true}).click();await expect(page.locator('.demo-banner')).toBeVisible();
 const browserResponse=page.waitForResponse(r=>r.url()===hub.baseUrl+'/api/state'&&r.status()===200);release();await done;await browserResponse;await painted(page);await page.screenshot({path:testInfo.outputPath('after-delayed-real-state.png'),fullPage:true});
 expect((await page.request.get(hub.baseUrl+'/api/state')).ok()).toBe(true);await expect(page.locator('.demo-banner')).toBeVisible();
});
test('lost workspace-switch response keeps actions blocked until the actual workspace is recovered',async({page})=>{
 let blockState=true;
 await page.route('**/api/state',route=>blockState?route.abort('failed'):route.continue());
 await page.route('**/api/demo',async route=>{const response=await route.fetch();expect(response.ok()).toBe(true);await route.abort('failed');});
 await page.getByRole('button',{name:'Open fixture workspace',exact:true}).click();
 await expect.poll(async()=>{const r=await page.request.get(hub.baseUrl+'/api/state');return (await r.json()).demo;}).toBe(true);
 await expect(page.locator('#main')).toHaveAttribute('inert','');
 blockState=false;await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await expect(page.locator('.demo-banner')).toBeVisible();await expect(page.locator('#main')).not.toHaveAttribute('inert','');
});
