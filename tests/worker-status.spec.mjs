import {navigateTo} from './navigation-helper.mjs';
import {test,expect} from '@playwright/test';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

test('worker status reads normal waiting, retains an outer failure and recovers from a failed read',async({page},testInfo)=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-worker-status-ui-')),hub=await createHub({directory,port:0,open:false,modelRunner:async()=>{throw new Error('No inference allowed');}}),ctx=hub.context(false),errors=[],external=[];
 try{
  page.on('pageerror',error=>errors.push(error.message));await page.context().route('**/*',route=>{if(new URL(route.request().url()).origin!==hub.baseUrl){external.push(route.request().url());return route.abort('blockedbyclient');}return route.continue();});
  await page.goto(hub.launchUrl);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();const response=page.waitForResponse(value=>new URL(value.url()).pathname==='/api/runtime');await navigateTo(page,'Automations');await (await response).finished();
  const panel=page.getByRole('region',{name:'Local worker status',exact:true});await expect(panel).toContainText('Waiting for work');await expect(panel).toContainText('Campaign off');
  const original=ctx.store.list.bind(ctx.store);ctx.engine.lastWaitingReviewAt=null;ctx.store.list=kind=>{if(kind==='decision')throw new Error('SYNTHETIC_PRIVATE_WORKER_ERROR');return original(kind);};try{await expect(ctx.engine.tick()).rejects.toThrow('SYNTHETIC_PRIVATE_WORKER_ERROR');}finally{ctx.store.list=original;}
  await panel.getByRole('button',{name:'Refresh worker status',exact:true}).click();await expect(panel).toContainText('A worker check failed');await expect(panel).not.toContainText('SYNTHETIC_PRIVATE');await panel.getByText('Worker check details',{exact:true}).click();await expect(panel).toContainText('Employer receipts establish application success');
  let failed=true;await page.route('**/api/runtime',route=>failed?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic status-read failure'})}):route.continue());
  await panel.getByRole('button',{name:'Refresh worker status'}).click();await expect(panel).toContainText('Status read failed');await expect(panel).toContainText('The previous read is retained');failed=false;await panel.getByRole('button',{name:'Refresh worker status'}).click();await expect(panel).toContainText('Waiting for work');await expect(panel.getByRole('button',{name:'Refresh worker status',exact:true})).toBeEnabled();await expect(panel).toContainText('A worker check failed');
  const evidence=path.resolve('docs/ai-automation-pass-2026-11-16/root/renders');await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${testInfo.project.name}-worker-status.png`),fullPage:false});
  await page.setViewportSize({width:320,height:900});await panel.getByRole('button',{name:'Refresh worker status'}).focus();await expect(panel.getByRole('button',{name:'Refresh worker status'})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:path.join(evidence,`${testInfo.project.name}-worker-status-mobile.png`),fullPage:false});
  expect(ctx.store.get('campaign','main').enabled).toBe(false);expect(ctx.store.list('run')).toHaveLength(0);expect(ctx.store.get('usage','model')).toBe(null);expect(errors).toEqual([]);expect(external).toEqual([]);
 }finally{await page.close();await hub.close();await rm(directory,{recursive:true,force:true});}
});
