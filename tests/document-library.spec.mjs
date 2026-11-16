import {test,expect} from '@playwright/test';
import {createHub} from '../server/index.mjs';
import {recoveryFixture} from './fixtures/view-recovery.mjs';

for(const width of [1366,390])test(`a library review selects its exact packet before offering approval at ${width}`,async({page})=>{
 const fixture=await recoveryFixture(createHub),{hub,store,packet}=fixture;
 store.put('package',{...packet,explanation:'Retained finished original, unchanged.'});
 let approvals=0;
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/action'&&request.postDataJSON()?.action==='reviewPackage')approvals++;});
 try{
  await page.setViewportSize({width,height:900});await page.goto(hub.launchUrl);
  await page.getByRole('button',{name:'Go to Résumés',exact:true}).click();
  const preview=page.getByRole('region',{name:'Selected document',exact:true});
  await expect(preview.getByRole('heading',{name:'Retained source.md',exact:true})).toBeVisible();
  await expect(preview.locator('.pdf-preview')).toHaveAttribute('data-rendered','true');
  await expect(page.getByRole('button',{name:'Approve document',exact:true})).toHaveCount(0);
  if(width<761)await page.locator('.document-chooser>summary').click();
  await page.getByRole('button',{name:'Review document',exact:true}).click();
  await expect(preview.getByRole('heading',{name:'Controls engineering intern',exact:true})).toBeFocused();
  await expect(preview).toContainText('Synthetic Recovery Lab');
  await expect(preview.locator('.pdf-preview')).toHaveAttribute('data-rendered','true');
  expect(approvals).toBe(0);expect(store.get('package',packet.id).approved).toBe(false);
  if(width<761)await expect(page.locator('.document-chooser')).not.toHaveAttribute('open','');
  await preview.getByRole('button',{name:'Approve document',exact:true}).click();
  await expect.poll(()=>store.get('package',packet.id).approved).toBe(true);
  expect(approvals).toBe(1);expect(store.get('campaign','main').enabled).toBe(false);expect(store.list('run')).toHaveLength(0);
 }finally{await page.close();await fixture.close();}
});
