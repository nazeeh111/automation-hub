import {test,expect} from '@playwright/test';
import {createHub} from '../server/index.mjs';
import {recoveryFixture} from './fixtures/view-recovery.mjs';

// Regression: VIEW-001, an optional render failure used to erase the whole workspace.
// The pre-boundary implementation blanked the application for this fault.
test('a failed application view preserves navigation and recovers the actual document without replaying an action',async({page})=>{
  const fixture=await recoveryFixture(createHub),{hub,store,packet}=fixture;
  let writes=0;
  page.on('request',request=>{if(request.method()==='POST')writes++;});
  try{
    await page.goto(hub.launchUrl);
    await page.getByRole('button',{name:'Go to Applications',exact:true}).click();
    await page.locator('[data-job-id="recovery-role"]').click();
    const recovery=page.getByRole('alert',{name:'View recovery',exact:true});
    await expect(recovery.getByRole('heading')).toHaveText('This application view could not be displayed');
    await expect(recovery.getByRole('heading')).toBeFocused();
    await expect(page.getByRole('navigation',{name:'Main navigation'})).toBeVisible();
    await expect(recovery).not.toContainText('Unexpected optional-view render input');
    await recovery.getByRole('button',{name:'Reopen view',exact:true}).click();
    await expect(recovery).toBeVisible();
    store.put('package',{...store.get('package',packet.id),explanation:'The retained original is available again.'});
    await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
    await recovery.getByRole('button',{name:'Reopen view',exact:true}).click();
    await expect(page.locator('.application-inspector .pdf-preview')).toHaveAttribute('data-rendered','true');
    await expect(page.locator('.application-inspector')).toContainText('The retained original is available again.');
    await page.getByRole('button',{name:'Close application inspector',exact:true}).click();
    await expect(page.locator('[data-job-id="recovery-role"]')).toBeFocused();
    expect(writes).toBe(0);expect(store.list('package')).toHaveLength(1);expect(store.list('run')).toHaveLength(0);expect(store.get('campaign','main').enabled).toBe(false);
  }finally{await page.close();await fixture.close();}
});

test('an unexpected workspace render failure offers explicit read-only recovery without a blind mutation retry',async({page})=>{
  const fixture=await recoveryFixture(createHub),{hub,store}=fixture;
  let writes=0;
  page.on('request',request=>{if(request.method()==='POST')writes++;});
  try{
    await page.addInitScript(()=>{Object.defineProperty(window,'__hubLaunchGeneration',{value:'synthetic-recovery-generation'});window.syntheticRecoveryReady=[];window.webkit={messageHandlers:{hub:{postMessage:message=>window.syntheticRecoveryReady.push({...message,committedRecovery:Boolean(document.querySelector('.view-recovery'))})}}};});
    await page.route('**/api/state',async route=>{const response=await route.fetch(),value=await response.json();await route.fulfill({response,json:{...value,jobs:{synthetic:'Unexpected render shape'}}});});
    await page.goto(hub.launchUrl);
    const recovery=page.getByRole('alert',{name:'View recovery',exact:true});
    await expect(recovery.getByRole('heading')).toHaveText('The workspace could not be displayed');
    await expect(recovery).not.toContainText('Unexpected render shape');
    await expect.poll(()=>page.evaluate(()=>window.syntheticRecoveryReady.length)).toBeGreaterThan(0);
    expect(await page.evaluate(()=>window.syntheticRecoveryReady.every(message=>message.action==='workspaceReady'&&message.generation==='synthetic-recovery-generation'&&message.committedRecovery===true))).toBe(true);
    await page.unroute('**/api/state');
    await recovery.getByRole('button',{name:'Reopen view',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
    expect(writes).toBe(0);expect(store.list('run')).toHaveLength(0);expect(store.get('campaign','main').enabled).toBe(false);
  }finally{await page.close();await fixture.close();}
});
