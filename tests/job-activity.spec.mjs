import {test,expect} from '@playwright/test';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

let hub,directory,external,errors;
const evidence=path.resolve('docs/ai-automation-pass-2026-11-16/design');
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
const eventLabel=index=>`Retained primary event ${String(index).padStart(3,'0')}`;
const history=page=>page.getByRole('region',{name:'Application execution history',exact:true});
const events=page=>history(page).locator('[data-event-id]');

test.beforeEach(async({page})=>{
 directory=await mkdtemp(path.join(tmpdir(),'hub-job-history-ui-'));
 hub=await createHub({directory,port:0,open:false,dev:false,discoveryOptions:{fetcher:async()=>{throw new Error('Synthetic test forbids external reads');}}});
 await hub.context(false).engine.stop({releaseWorker:false});
 external=[];errors=[];
 await page.context().route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==hub.baseUrl){external.push(url.href);return route.abort('blockedbyclient');}return route.continue();});
 page.on('pageerror',error=>errors.push(error.message));
 const store=hub.context(false).store;
 for(const [id,title,employer] of [['history-alpha','Primary internship','Primary Labs'],['history-beta','Secondary internship','Secondary Labs'],['history-empty','Quiet internship','Quiet Labs']])store.put('job',{id,title,employer,url:`https://fixture.example.invalid/${id}`,state:'imported',nextAction:'Read this exact saved posting',revision:0,evidence:[]});
 for(let index=0;index<65;index++)store.put('event',{id:`history-alpha-${index}`,applicationId:'history-alpha',type:'preparation_step',payload:{detail:eventLabel(index),privatePath:'/synthetic-private-path/not-for-display'},at:'2026-11-01T12:00:00.000Z'});
 store.event('history-beta','posting_read',{detail:'Only the secondary application belongs here'});
 // These newer unrelated events push every primary event outside /api/state's
 // latest-150 summary. The inspector must use the actual per-application API.
 for(let index=0;index<170;index++)store.event(`unrelated-${index}`,'unrelated_activity',{detail:'Unrelated workspace activity'});
 await page.goto(hub.launchUrl);await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Go to Applications',exact:true}).click();
});
test.afterEach(async({page})=>{await page.close();await hub?.close();await rm(directory,{recursive:true,force:true});expect(external).toEqual([]);expect(errors).toEqual([]);});
const open=async(page,id)=>{await page.locator(`[data-job-id="${id}"]`).click();await page.getByRole('tab',{name:/^Evidence/}).click();await expect(history(page)).toBeVisible();};

test('old application events remain readable beyond the global summary and page through the saved beginning',async({page},testInfo)=>{
 await open(page,'history-alpha');await expect(events(page)).toHaveCount(30);await expect(events(page).first()).toContainText(eventLabel(64));await expect(history(page)).not.toContainText('Unrelated workspace activity');
 await history(page).getByRole('button',{name:'Load earlier events',exact:true}).click();await expect(events(page)).toHaveCount(60);await expect(events(page).nth(30)).toContainText(eventLabel(34));
 await history(page).getByRole('button',{name:'Load earlier events',exact:true}).click();await expect(events(page)).toHaveCount(65);await expect(events(page).last()).toContainText(eventLabel(0));await expect(history(page)).toContainText('Beginning of saved history');await expect(history(page).getByRole('button',{name:'Load earlier events',exact:true})).toHaveCount(0);await expect(history(page).getByRole('status')).toBeFocused();await expect(history(page)).not.toContainText('/synthetic-private-path');
 const ids=await events(page).evaluateAll(elements=>elements.map(element=>element.dataset.eventId));expect(new Set(ids).size).toBe(65);
 await mkdir(evidence,{recursive:true});await page.screenshot({path:path.join(evidence,`${testInfo.project.name}-history-complete.png`),fullPage:true});
 hub.context(false).store.event('history-alpha','manual_note',{detail:'New retained event after the first history read'});await history(page).getByRole('button',{name:'Refresh application history',exact:true}).click();await expect(events(page)).toHaveCount(30);await expect(events(page).first()).toContainText('New retained event after the first history read');
});

test('an earlier-page failure preserves loaded events and retry cannot dispatch twice',async({page})=>{
 await open(page,'history-alpha');await expect(events(page)).toHaveCount(30);
 let attempts=0;const held=defer(),arrived=defer();
 await page.route('**/api/jobs/history-alpha/events?*',async route=>{if(!new URL(route.request().url()).searchParams.has('before'))return route.continue();attempts++;if(attempts===1)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic earlier-page outage'})});arrived.resolve();await held.promise;return route.continue();});
 await history(page).getByRole('button',{name:'Load earlier events',exact:true}).click();await expect(history(page).getByRole('alert')).toContainText('Synthetic earlier-page outage');await expect(events(page)).toHaveCount(30);await expect(history(page)).toContainText('Your loaded history has been kept');
 try{
  await history(page).getByRole('button',{name:'Try again',exact:true}).click();await arrived.promise;
  const loading=history(page).getByRole('button',{name:'Loading earlier events…',exact:true});await expect(loading).toHaveAttribute('aria-disabled','true');await loading.focus();await page.keyboard.press('Enter');expect(attempts).toBe(2);
 }finally{held.resolve();}
 await expect(events(page)).toHaveCount(60);expect(attempts).toBe(2);await expect(history(page).getByRole('alert')).toHaveCount(0);
});

test('initial failure offers an honest retry and a quiet application has no invented history',async({page})=>{
 let first=true;
 await page.route('**/api/jobs/history-empty/events?*',route=>{if(first){first=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Synthetic initial history outage'})});}return route.continue();});
 await open(page,'history-empty');await expect(history(page).getByRole('alert')).toContainText('Synthetic initial history outage');await expect(events(page)).toHaveCount(0);await expect(history(page)).not.toContainText('No execution history yet');
 await history(page).getByRole('button',{name:'Try again',exact:true}).click();await expect(history(page)).toContainText('No execution history yet');await expect(history(page).getByRole('alert')).toHaveCount(0);
});

test('late history from a previous selected application cannot replace the current application',async({page})=>{
 const held=defer(),arrived=defer();
 await page.route('**/api/jobs/history-alpha/events?*',async route=>{arrived.resolve();await held.promise;return route.continue();});
 const oldResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/jobs/history-alpha/events');
 try{
  await open(page,'history-alpha');await arrived.promise;await expect(history(page)).toContainText('Loading saved application history');
  await page.getByRole('button',{name:'Close application inspector',exact:true}).click();await page.locator('[data-job-id="history-beta"]').click();await page.getByRole('tab',{name:/^Evidence/}).click();await expect(history(page)).toContainText('Only the secondary application belongs here');
 }finally{held.resolve();}
 await (await oldResponse).finished();
 await expect(events(page)).toHaveCount(1);await expect(history(page)).not.toContainText('Retained primary event');
});

test('a completed real history read held across a fixture switch cannot cross the workspace boundary',async({page})=>{
 const fixture=hub.context(true);await fixture.engine.stop({releaseWorker:false});
 fixture.store.put('job',{id:'history-alpha',title:'Primary internship',employer:'Fixture Labs',url:'https://fixture.example.invalid/history-alpha',state:'imported',nextAction:'Read the fixture posting',revision:0,evidence:[]});
 fixture.store.event('history-alpha','fixture_history',{detail:'This history belongs only to the fixture workspace'});
 const held=defer(),arrived=defer();let capturedRealEvents;
 await page.route('**/api/jobs/history-alpha/events?*',async route=>{
  if(route.request().headers()['x-hub-workspace']!=='real')return route.continue();
  // Capture a successful real response before switching, then deliver that
  // exact old body later. A server-side409 cannot mask a missing UI fence.
  const response=await route.fetch();expect(response.status()).toBe(200);capturedRealEvents=(await response.json()).events;arrived.resolve();await held.promise;return route.fulfill({response});
 });
 const oldResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/jobs/history-alpha/events'&&response.request().headers()['x-hub-workspace']==='real');
 try{
  await open(page,'history-alpha');await arrived.promise;expect(capturedRealEvents).toHaveLength(30);await expect(history(page)).toContainText('Loading saved application history');
  const switched=await page.request.post(hub.baseUrl+'/api/demo',{headers:{Origin:hub.baseUrl,'X-Hub-Workspace':'real'},data:{enabled:true}});expect(switched.status()).toBe(200);expect((await switched.json()).demo).toBe(true);
  const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/state');await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await (await refreshed).finished();await expect(page.locator('.demo-banner')).toBeVisible();await expect(page.locator('.application-inspector')).toHaveCount(0);
  await open(page,'history-alpha');await expect(history(page)).toContainText('This history belongs only to the fixture workspace');await expect(events(page)).toHaveCount(1);
 }finally{held.resolve();}
 await (await oldResponse).finished();await expect(history(page)).toContainText('This history belongs only to the fixture workspace');await expect(events(page)).toHaveCount(1);await expect(history(page)).not.toContainText('Retained primary event');await expect(page.locator('.demo-banner')).toBeVisible();
 expect(hub.context(false).store.list('event').filter(event=>event.applicationId==='history-alpha')).toHaveLength(65);expect(fixture.store.list('event').filter(event=>event.applicationId==='history-alpha')).toHaveLength(1);
});

test('the mobile history and its earlier-page control fit and remain keyboard reachable',async({page},testInfo)=>{
 await page.setViewportSize({width:320,height:900});await open(page,'history-alpha');await expect(events(page)).toHaveCount(30);
 const button=history(page).getByRole('button',{name:'Load earlier events',exact:true});await button.focus();await page.keyboard.press('Enter');await expect(events(page)).toHaveCount(60);
 const geometry=await history(page).evaluate(element=>({width:element.scrollWidth,client:element.clientWidth,page:document.documentElement.scrollWidth,viewport:innerWidth}));expect(geometry.width).toBeLessThanOrEqual(geometry.client+1);expect(geometry.page).toBeLessThanOrEqual(geometry.viewport);
 await mkdir(evidence,{recursive:true});
 await page.locator('.application-inspector').evaluate(element=>{element.scrollTop=0;});await page.screenshot({path:path.join(evidence,`${testInfo.project.name}-history-mobile320-top.png`)});
 await history(page).getByRole('button',{name:'Load earlier events',exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,`${testInfo.project.name}-history-mobile320-bottom.png`)});
});
