import {test,expect} from '@playwright/test';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';
import {parseDiscoverySource} from '../server/job-discovery.mjs';

let hub,directory,sourceReads;
test.use({viewport:{width:1440,height:900}});
const sourceLabel='Synthetic Engineering Studio';
const posted='2026-11-14T12:00:00.000Z';
function seed(number=3,{long=false}={}){
 const store=hub.context(false).store,source=parseDiscoverySource('https://job-boards.greenhouse.io/synthetic-engineering-studio'),observed=new Date().toISOString();
 store.put('discovery_source',{...source,label:sourceLabel,status:'ready',coverage:'complete',lastObservedAt:observed,lastAttemptAt:observed,jobCount:number,revision:1});
 for(let index=0;index<number;index++)store.put('discovery_candidate',{id:`${source.id}:ui-${String(index).padStart(3,'0')}`,sourceId:source.id,provider:'greenhouse',region:'us',externalId:`ui-${index}`,company:sourceLabel,locationScope:'us',title:long&&index===0?'Electrical engineering internship / طراحی سامانه‌های embedded / 電気工学 / '+ 'Long title '.repeat(15):index===number-1?'Photonics hardware internship':`Systems engineering intern ${String(index).padStart(3,'0')}`,location:long?'Blacksburg, Virginia / Alexandria / München / '+ 'Extended location '.repeat(12):index===number-1?'Blacksburg, Virginia':'Boston, Massachusetts',department:'Electrical engineering',employmentType:'internship',workplaceType:index===number-1?'remote':'hybrid',description:'Synthetic fixture only. Electrical engineering internship involving sensors.\n\nFull source requirements stay visible.',url:`https://job-boards.greenhouse.io/synthetic-engineering-studio/jobs/${index+1}`,canonicalUrl:`https://job-boards.greenhouse.io/synthetic-engineering-studio/jobs/${index+1}`,postedAt:index===number-1?posted:null,sourceUpdatedAt:posted,firstSeenAt:observed,lastSeenAt:observed,availability:'active',supportStatus:index===number-1?'external_portal':'portal_review_required',supportDetail:index===number-1?'This external application portal requires review.':'Employer portal support is reviewed during preparation.'});
 return {source,observed,store};
}
async function openDiscover(page){
 await page.goto(hub.launchUrl);
 await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Open workspace',exact:true}).click();
 await page.locator('#workspace-tab-discover').click();
 await expect(page.getByRole('heading',{name:'Internships',exact:true})).toBeVisible();
 await expect(page.locator('.jd-results-layout')).toHaveAttribute('aria-busy','false');
}
test.beforeEach(async({page})=>{
 await page.addInitScript(()=>{const schedule=window.setInterval;window.setInterval=(callback,delay,...args)=>schedule(delay===5000?()=>{}:callback,delay,...args);});
 directory=await mkdtemp(path.join(tmpdir(),'hub-discovery-ui-'));
 sourceReads=0;hub=await createHub({directory,port:0,open:false,discoveryOptions:{resolver:async()=>[{address:'93.184.216.34',family:4}],fetcher:async()=>{sourceReads++;return new Response(JSON.stringify([{id:'synthetic-fetched',text:'Synthetic fetched engineering internship',categories:{location:'Boston, Massachusetts',department:'Engineering',commitment:'Intern'},workplaceType:'hybrid',descriptionPlain:'Synthetic read fixture only.',hostedUrl:'https://jobs.lever.co/synthetic-studio/synthetic-fetched'}]));}}});
});
test.afterEach(async({page})=>{await page.close();await hub?.close();await rm(directory,{recursive:true,force:true});});

test('first run offers real source setup without a resume or invented catalog',async({page},testInfo)=>{
 await openDiscover(page);
 await expect(page.getByRole('heading',{name:'Start with an employer you want to work for'})).toBeVisible();
 await expect(page.getByLabel('Employer job board URL')).toBeVisible();
 await expect(page.locator('.jd-job-card')).toHaveCount(0);
 await page.screenshot({path:testInfo.outputPath('first-run.png'),fullPage:true});
 await page.getByLabel('Employer job board URL').fill('https://jobs.lever.co/synthetic-studio');
 await page.getByLabel('Source company name').fill('Synthetic Studio');
 await page.getByRole('button',{name:'Add source',exact:true}).click();
 await expect(page.locator('.jd-source-list')).toContainText('Synthetic Studio');
 await expect(page.locator('.jd-source-list')).toContainText('No successful check yet');
 await expect(page.getByRole('button',{name:'Check jobs',exact:true})).toBeVisible();
 expect(hub.context(false).store.list('discovery_candidate')).toHaveLength(0);
 expect(hub.context(false).store.list('resume')).toHaveLength(0);
 expect(hub.context(false).store.get('campaign','main').enabled).toBe(false);
 expect(sourceReads).toBe(0);await page.getByRole('button',{name:'Check jobs',exact:true}).click();
 await expect(page.locator('.jd-job-card')).toContainText('Synthetic fetched engineering internship');expect(sourceReads).toBe(1);
 await page.screenshot({path:testInfo.outputPath('first-source-checked.png'),fullPage:true});
});

test('search reaches beyond the first page, favorites persist and queuing stays separate from submission',async({page},testInfo)=>{
 seed(65);await openDiscover(page);
 await expect(page.locator('.jd-job-card')).toHaveCount(40);
 await expect(page.locator('.jd-pagination')).toContainText('of 65');
 await page.screenshot({path:testInfo.outputPath('desktop-browse.png')});
 const geometry={viewport:page.viewportSize(),firstRole:await page.locator('.jd-job-card').first().boundingBox(),document:await page.evaluate(()=>({width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,scrollY:window.scrollY}))};await writeFile(testInfo.outputPath('desktop-geometry.json'),JSON.stringify(geometry,null,2));
 await page.getByLabel('Search discovered jobs').fill('photonics');
 await expect(page.locator('.jd-job-card')).toHaveCount(1);
 await expect(page.locator('.jd-job-card')).toContainText('Photonics hardware internship');
 await page.getByRole('button',{name:'Save Photonics hardware internship',exact:true}).click();
 await expect(page.getByRole('button',{name:'Unsave Photonics hardware internship',exact:true})).toHaveAttribute('aria-pressed','true');
 expect(hub.context(false).store.list('job')).toHaveLength(0);
 await page.getByRole('button',{name:`Details for Photonics hardware internship at ${sourceLabel}`,exact:true}).click();
 const detail=page.getByRole('region',{name:'Job details'});
 await expect(detail).toContainText('Nov 14, 2026');
 await expect(detail).toContainText('First found');
 await expect(detail).toContainText('External portal');
 await page.screenshot({path:testInfo.outputPath('desktop-detail.png')});
 await expect(detail.getByRole('link',{name:'Open employer posting'})).toHaveAttribute('target','_blank');
 await detail.getByRole('button',{name:'Add to application queue',exact:true}).click();
 await expect(detail.getByRole('button',{name:'In application queue',exact:true})).toBeVisible();
 expect(hub.context(false).store.list('job')).toHaveLength(1);
 expect(hub.context(false).store.list('job')[0].state).toBe('imported');
 expect(hub.context(false).store.get('campaign','main').enabled).toBe(false);
 await page.reload();await page.getByRole('button',{name:'Open workspace',exact:true}).click();await page.locator('#workspace-tab-discover').click();
 await page.getByRole('button',{name:/^Saved 1$/}).click();
 await expect(page.locator('.jd-job-card')).toHaveCount(1);
 await expect(page.locator('.jd-job-card')).toContainText('Photonics hardware internship');
});

test('a late filter response cannot replace newer results and failed reads keep filters with a retry',async({page})=>{
 seed(6);await openDiscover(page);
 let release,arrived,delivered;const gate=new Promise(resolve=>release=resolve),seen=new Promise(resolve=>arrived=resolve),done=new Promise(resolve=>delivered=resolve);
 await page.route('**/api/discovery?**',async route=>{const url=new URL(route.request().url());if(url.searchParams.get('query')==='systems'){const response=await route.fetch();arrived();await gate;await route.fulfill({response});delivered();}else await route.continue();});
 await page.getByLabel('Search discovered jobs').fill('systems');await seen;
 await page.getByLabel('Search discovered jobs').fill('photonics');
 await expect(page.locator('.jd-job-card')).toHaveCount(1);await expect(page.locator('.jd-job-card')).toContainText('Photonics');
 release();await done;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await expect(page.locator('.jd-results-layout')).toHaveAttribute('aria-busy','false');
 await expect(page.locator('.jd-job-card')).toHaveCount(1);await expect(page.locator('.jd-job-card')).toContainText('Photonics');
 let fail=true;
 await page.route('**/api/discovery?**',async route=>{const url=new URL(route.request().url());if(fail&&url.searchParams.get('query')==='retry-needle')await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic source result failure'})});else await route.continue();});
 await page.getByLabel('Search discovered jobs').fill('retry-needle');
 await expect(page.locator('.jd-query-error')).toContainText('Jobs could not be loaded');
 await expect(page.getByLabel('Search discovered jobs')).toHaveValue('retry-needle');
 await expect(page.locator('.jd-job-card')).toContainText('Photonics');
 fail=false;await page.getByRole('button',{name:'Try again',exact:true}).click();
 await expect(page.getByRole('heading',{name:'No roles match these filters'})).toBeVisible();
 await expect(page.locator('.jd-query-error')).toHaveCount(0);
});

test('unavailable saved jobs remain visible with unknown posted dates and cannot enter the queue',async({page})=>{
 const {store}=seed(3),row=store.list('discovery_candidate')[0];
 store.put('discovery_favorite',{id:row.id,favorite:true});store.remove('discovery_source',row.sourceId);
 await openDiscover(page);await page.getByRole('button',{name:/^Saved 1$/}).click();
 await expect(page.locator('.jd-job-card')).toHaveCount(1);
 await expect(page.locator('.jd-job-card')).toContainText('Posted date unknown');
 await expect(page.locator('.jd-job-card')).toContainText('Availability needs a source check');
 await page.getByRole('button',{name:`Details for ${row.title} at ${sourceLabel}`,exact:true}).click();
 await expect(page.getByRole('button',{name:'Add to application queue',exact:true})).toBeDisabled();
 await expect(page.getByRole('region',{name:'Job details'})).toContainText('Date not supplied by source');
 expect(store.list('job')).toHaveLength(0);
});

test('a successful HTTP response without a confirmed queue record does not show queued',async({page})=>{
 seed(2);await openDiscover(page);
 await page.getByRole('button',{name:`Details for Photonics hardware internship at ${sourceLabel}`,exact:true}).click();
 await page.route('**/api/action',async route=>{if(route.request().postDataJSON()?.action==='discoveryQueue')await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({queued:false,errors:[{message:'Synthetic import hold'}]})});else await route.continue();});
 await page.getByRole('button',{name:'Add to application queue',exact:true}).click();
 await expect(page.locator('.jd-feedback-error')).toContainText('not confirmed in the application queue');
 await expect(page.getByRole('button',{name:'In application queue',exact:true})).toHaveCount(0);
 expect(hub.context(false).store.list('job')).toHaveLength(0);
});

test('mobile long text and keyboard detail navigation preserve a usable layout',async({page},testInfo)=>{
 const {store}=seed(3,{long:true});await page.setViewportSize({width:390,height:844});await openDiscover(page);
 await expect(page.locator('.jd-filters')).not.toBeVisible();
 await page.getByRole('button',{name:'Filters',exact:true}).click();
 await page.getByLabel('Filter discovered location').fill('München');
 await expect(page.locator('.jd-job-card')).toHaveCount(3);
 await page.getByLabel('Filter field or major keyword').fill('does-not-exist');
 await expect(page.getByRole('heading',{name:'No roles match these filters'})).toBeVisible();
 await page.getByRole('button',{name:'Clear filters',exact:true}).first().click();
 await page.getByRole('button',{name:'Filters',exact:true}).click();
 const row=store.list('discovery_candidate')[0],button=page.getByRole('button',{name:`Details for ${row.title} at ${sourceLabel}`,exact:true});
 await button.focus();await page.keyboard.press('Enter');
 await expect(page.getByRole('region',{name:'Job details'})).toBeVisible();
 await expect(page.locator('.jd-detail h3')).toBeFocused();
 const queueBounds=await page.getByRole('button',{name:'Add to application queue',exact:true}).boundingBox();expect(queueBounds.y).toBeGreaterThanOrEqual(0);expect(queueBounds.y+queueBounds.height).toBeLessThanOrEqual(page.viewportSize().height);
 await page.screenshot({path:testInfo.outputPath('mobile-detail-viewport.png')});
 await page.screenshot({path:testInfo.outputPath('mobile-detail.png'),fullPage:true});
 await page.getByRole('button',{name:'Close job details',exact:true}).click();
 await expect(button).toBeFocused();
 const geometry=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth}));
 expect(geometry.scroll).toBeLessThanOrEqual(geometry.width+1);
 await page.screenshot({path:testInfo.outputPath('mobile-list-viewport.png')});
 await page.screenshot({path:testInfo.outputPath('mobile-long-text.png'),fullPage:true});
});


test('US internships are the default, uncertain geography is reviewable and all saved roles stay accessible',async({page})=>{
 const {store}=seed(5),rows=store.list('discovery_candidate');
 store.put('discovery_candidate',{...rows[1],location:'Toronto, Ontario, Canada',locationScope:'outside_us'});
 store.put('discovery_candidate',{...rows[2],location:'Remote',locationScope:'unknown'});
 store.put('discovery_candidate',{...rows[3],title:'Senior photonics engineer',employmentType:'full-time',locationScope:'us'});
 store.put('discovery_candidate',{...rows[4],title:'Senior systems engineer',employmentType:'full-time',location:'Remote',locationScope:'unknown'});
 store.put('discovery_favorite',{id:rows[1].id,favorite:true});
 await openDiscover(page);
 await expect(page.getByRole('button',{name:'US internships',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.locator('.jd-job-card')).toHaveCount(1);
 await expect(page.locator('.jd-job-card')).toContainText(rows[0].title);
 await page.getByLabel('Search discovered jobs',{exact:true}).fill('systems');
 await expect(page.getByRole('button',{name:'Review uncertain locations (1)',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Review uncertain locations (1)',exact:true}).click();
 await expect(page.locator('.jd-job-card')).toHaveCount(1);
 await expect(page.locator('.jd-job-card')).toContainText(rows[2].title);
 await expect(page.locator('.jd-job-card')).toContainText('US location not established');
 await expect(page.locator('.jd-scope-note')).toContainText('not been counted as US roles');
 await expect(page.getByLabel('Search discovered jobs',{exact:true})).toHaveValue('systems');
 await page.getByRole('button',{name:'Clear filters',exact:true}).first().click();
 await page.getByRole('button',{name:/^All jobs 5$/}).click();
 await expect(page.locator('.jd-job-card')).toHaveCount(5);
 await page.getByRole('button',{name:/^Saved 1$/}).click();
 await expect(page.locator('.jd-job-card')).toHaveCount(1);
 await expect(page.locator('.jd-job-card')).toContainText('Toronto, Ontario, Canada');
 await expect(page.locator('.jd-job-card')).toContainText('Outside the US');
});
