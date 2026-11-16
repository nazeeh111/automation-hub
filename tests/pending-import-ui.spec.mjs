import {test,expect} from '@playwright/test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHub} from '../server/index.mjs';

let hub,directory;
test.beforeEach(async({page})=>{
 await page.addInitScript(()=>{
  const interval=window.setInterval;
  window.setInterval=(callback,delay,...args)=>interval(delay===5000?()=>{}:callback,delay,...args);
 });
 directory=await mkdtemp(path.join(tmpdir(),'hub-pending-import-'));
 hub=await createHub({directory,port:0,open:false});
 await page.goto(hub.launchUrl);
 await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
});
test.afterEach(async({page})=>{
 await page.close();await hub?.close();await rm(directory,{recursive:true,force:true});
});

test('a pending real resume read cannot dispatch after another tab switches to fixture and the UI refreshes',async({page})=>{
 const filename='Pending real workspace intent.md';let importDispatches=0;
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/import/resumes')importDispatches++;});
 await page.getByRole('button',{name:'Open workspace',exact:true}).click();
 await page.locator('#workspace-tab-resumes').click();
 await page.getByRole('button',{name:'Import resumes',exact:true}).first().click();
 await page.evaluate(target=>{
  const original=FileReader.prototype.readAsDataURL;
  FileReader.prototype.readAsDataURL=function(file){
   if(file.name!==target)return original.call(this,file);
   window.pendingResumeRead=true;window.releasePendingResumeRead=()=>{FileReader.prototype.readAsDataURL=original;original.call(this,file);};
  };
 },filename);
 await page.locator('input[type=file][multiple]').setInputFiles({name:filename,mimeType:'text/markdown',buffer:Buffer.from('# Synthetic Real Intent\nEngineering student\n\n## Skills\nPython\n')});
 await page.getByRole('button',{name:'Import 1 resume',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>window.pendingResumeRead===true)).toBe(true);
 // A user can close the dialog while encoding continues. Its native modal
 // correctly prevents clicking the dashboard header behind it.
 await page.getByRole('button',{name:'Close dialog',exact:true}).click();

 // The context's HTTP client shares the browser session cookie, as another tab would.
 const switched=await page.request.post(hub.baseUrl+'/api/demo',{headers:{Origin:hub.baseUrl,'X-Hub-Workspace':'real'},data:{enabled:true}});
 expect(switched.status()).toBe(200);expect((await switched.json()).demo).toBe(true);
 await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
 await expect(page.locator('.demo-banner')).toBeVisible();
 const fixtureCount=hub.context(true).store.list('resume').length;
 expect(fixtureCount).toBe(1);

 await page.evaluate(()=>window.releasePendingResumeRead());
 await expect(page.getByRole('alert')).toContainText(/workspace changed|reconnect/i);
 expect(importDispatches).toBe(0);
 expect(hub.context(false).store.list('resume').some(resume=>resume.name===filename)).toBe(false);
 expect(hub.context(true).store.list('resume').some(resume=>resume.name===filename)).toBe(false);
 expect(hub.context(true).store.list('resume')).toHaveLength(fixtureCount);
 await expect(page.locator('.demo-banner')).toBeVisible();
});
