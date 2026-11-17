import {test,expect} from '@playwright/test';
import {createHub} from '../server/index.mjs';
import {recoveryFixture} from './fixtures/view-recovery.mjs';
import {parseDiscoverySource} from '../server/job-discovery.mjs';
import {navigateTo} from './navigation-helper.mjs';

test('exact review loads its PDF immediately and rendered inspector never overlaps following actions',async({page})=>{
 const fixture=await recoveryFixture(createHub),{hub,store,packet,job}=fixture;
 store.put('package',{...packet,explanation:'Finished original retained unchanged.'});
 store.put('decision',{id:'final-document-review',jobId:job.id,state:'open',code:'package_review',title:'Review exact retained document',details:{packageId:packet.id,hash:packet.hash}});
 try{
  await page.goto(hub.launchUrl);await page.getByRole('button',{name:'Needs You',exact:true}).click();
  await expect(page.locator('.decision-resume-preview .pdf-preview')).toHaveAttribute('data-rendered','true');
  await expect(page.getByRole('button',{name:'Approve this version',exact:true})).toBeEnabled();
  expect(store.get('package',packet.id).approved).toBe(false);
  await page.getByRole('button',{name:'Home',exact:true}).click();await page.getByRole('button',{name:'Go to Applications',exact:true}).click();await page.locator(`[data-job-id="${job.id}"]`).click();
  await page.getByRole('tab',{name:'Document',exact:true}).click();await expect(page.locator('.inspector-pdf .pdf-preview')).toHaveAttribute('data-rendered','true');
  const geometry=await page.evaluate(()=>{const pdf=document.querySelector('.inspector-pdf'),approval=[...document.querySelectorAll('.inspector-content button')].find(button=>button.textContent.trim()==='Approve this document');return {pdfBottom:pdf.getBoundingClientRect().bottom,approvalTop:approval.getBoundingClientRect().top,canvasHeight:pdf.querySelector('.pdf-canvas-wrap').getBoundingClientRect().height};});
  expect(geometry.pdfBottom).toBeLessThanOrEqual(geometry.approvalTop);expect(geometry.canvasHeight).toBeLessThanOrEqual(561);expect(geometry.canvasHeight).toBeGreaterThan(200);
  await page.keyboard.press('Escape');await page.setViewportSize({width:390,height:844});await navigateTo(page,'Needs You');await page.locator('[data-question-id="final-document-review"]').click();
  await expect(page.locator('.decision-resume-preview .pdf-preview')).toHaveAttribute('data-rendered','true');
  const back=await page.getByRole('button',{name:'All saved questions',exact:true}).boundingBox(),header=await page.locator('.studio-topbar').boundingBox();expect(back.y).toBeGreaterThanOrEqual(header.y+header.height);
  expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('run')).toHaveLength(0);expect(store.get('package',packet.id).approved).toBe(false);
 }finally{await page.close();await fixture.close();}
});

test('refresh receipt labels previous successful partial observations without inventing removed jobs',async({page})=>{
 const fixture=await recoveryFixture(createHub),{hub,store}=fixture,source=parseDiscoverySource('https://jobs.lever.co/synthetic-summary');
 store.put('package',{...fixture.packet,explanation:'Retained unchanged.'});
 store.put('discovery_source',{...source,label:'Synthetic Summary Lab',status:'unavailable',lastErrorCode:'SOURCE_TIMEOUT',lastObservedAt:'2026-11-16T12:00:00Z',lastRefreshSummary:{version:1,sourceId:source.id,observedAt:'2026-11-16T12:00:00Z',previousObservedAt:'2026-11-15T12:00:00Z',baseline:false,coverage:'partial',observedCount:4,counts:{baseline:0,new:1,changed:1,seenAgain:2,noLongerListed:null}}});
 try{
  await page.goto(hub.launchUrl);await page.getByRole('button',{name:'Go to Discover',exact:true}).click();await page.getByRole('button',{name:'1 source',exact:true}).click();
  const receipt=page.locator('.jd-refresh-summary');await expect(receipt).toContainText('1 newly found, 1 changed, 2 seen again');await expect(receipt).toContainText('partial board, absence not assessed');await expect(receipt).toContainText('Successful check');await expect(receipt).not.toContainText('no longer listed');await expect(page.locator('.jd-source-list')).toContainText('Check failed');
  expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('run')).toHaveLength(0);
 }finally{await page.close();await fixture.close();}
});

test('folded menu owns its keyboard interaction and workspace search remains readable at every width',async({page})=>{
 const fixture=await recoveryFixture(createHub),{hub,store}=fixture;store.put('package',{...fixture.packet,explanation:'Retained unchanged.'});
 try{
  await page.goto(hub.launchUrl);await expect(page.getByRole('button',{name:'Find in your workspace',exact:true})).toBeEnabled();
  for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:844});
   if(width<1100){const menu=page.getByRole('button',{name:'Open navigation',exact:true});await menu.click();await page.keyboard.press('Control+k');await expect(page.getByRole('dialog',{name:'Workspace navigation',exact:true})).toBeVisible();await expect(page.locator('.quick-open')).toHaveCount(0);await page.keyboard.press('Escape');await expect(menu).toBeFocused();}
   await page.keyboard.press('Control+k');const search=page.getByRole('dialog',{name:'Find in your workspace',exact:true});await expect(search).toBeVisible();const input=search.getByRole('combobox');await expect(input).toBeFocused();const option=search.getByRole('option').first();expect(await option.evaluate(el=>getComputedStyle(el).display)).toBe('grid');expect((await option.boundingBox()).height).toBeGreaterThanOrEqual(44);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.keyboard.press('ArrowDown');await expect(search.getByRole('option').nth(1)).toHaveAttribute('aria-selected','true');await page.keyboard.press('Escape');await expect(search).toHaveCount(0);
  }
  expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('run')).toHaveLength(0);
 }finally{await page.close();await fixture.close();}
});
