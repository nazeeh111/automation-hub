import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

test('Home brings real saved questions before the process and opens the exact decision at desktop and phone sizes',async({page})=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-switchboard-ui-')),hub=await createHub({directory,port:0,open:false}),store=hub.context(false).store;
 try{
  await hub.context(false).engine.stop({releaseWorker:false});
  store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:'candidate@example.invalid'});store.put('resume',{id:'synthetic-resume',name:'Finished original',mega:false});
  for(let i=0;i<4;i++){store.put('job',{id:`switchboard-${i}`,title:`Synthetic engineering internship ${i}`,employer:`Example employer ${i}`,url:`https://fixture.example.invalid/switchboard/${i}`,state:'needs_you',revision:0});store.put('decision',{id:`switchboard-question-${i}`,jobId:`switchboard-${i}`,state:'open',code:'account_access',title:`Review saved access ${i}`,reason:'Review this exact retained question.'});}
  await page.goto(hub.launchUrl);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:900});const shelf=page.getByRole('complementary',{name:'Waiting for you',exact:true}),first=shelf.getByRole('button').first();
   await expect(first).toContainText('Review saved access 0');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   const bounds=await first.boundingBox(),nav=await page.locator('.sidebar').boundingBox();expect(bounds.y+bounds.height).toBeLessThan(width<700?nav.y:900);
   expect(await page.locator('.home-attention-shelf').evaluate(el=>Boolean(el.compareDocumentPosition(document.querySelector('.home-process'))&Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
   await expect(page.getByRole('button',{name:'Open workspace',exact:true})).toHaveCount(0);await first.focus();await page.keyboard.press('Enter');await expect(page.locator('[data-attention-id="switchboard-question-0"] h2')).toBeFocused();
   const index=page.getByRole('region',{name:'Saved question index',exact:true});await expect(index.getByLabel('Jump to a saved question',{exact:true})).toBeVisible();expect((await index.boundingBox()).height).toBeLessThan(100);
   await page.getByRole('button',{name:'Home',exact:true}).click();
  }
  expect(store.list('decision').filter(item=>item.state==='open')).toHaveLength(4);expect(store.list('run')).toHaveLength(0);expect(store.get('campaign','main').enabled).toBe(false);
 }finally{await page.close();await hub.close();await rm(directory,{recursive:true,force:true});}
});
