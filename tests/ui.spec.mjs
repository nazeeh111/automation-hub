import {navigateTo,workspaceSection} from './navigation-helper.mjs';
import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHub } from '../server/index.mjs';
import { questionFingerprint } from '../server/writing-policy.mjs';
import { supportingControlFingerprint } from '../server/supporting-policy.mjs';
import { assessRequirements } from '../server/requirements.mjs';
import { assessApplicationLimits } from '../server/application-limits.mjs';
import { zipSync, strToU8 } from 'fflate';
import { reviewWaitingDecisions } from '../server/waiting-review.mjs';

// Firefox can report a 44px CSS target as 43.999992px after layout.
const TOUCH_TARGET_FLOOR = 44 - 0.01;

async function fixtureModelRunner(input) {
 if(input.task==='draftWriting'){
   const source=input.sourceCatalog.find(item=>item.kind==='resume_fact'&&/simulated sensor prototype/i.test(item.text));
   return {sentences:[{text:source.text.replace(/^[-•]\s*/,''),sourceIds:[source.id]}],missingFacts:['Your personal motivation for this employer was not supplied.'],explanation:'Synthetic fixture: one exact resume passage, with no invented motivation.'};
 }
 return {chosenResumeId:input.probe?'synthetic-resume':input.resumes?.[0]?.id,explanation:'Controlled UI fixture uses unchanged supplied facts.',edits:[],requirements:[],questions:[]};
}
let pageErrors,hub, directory,n8nNow,n8nFault,n8nCalls,n8nWorkflow,n8nExecutions;
test.beforeEach(async ({ page }) => {
  pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
  n8nNow=Date.now();n8nFault=false;n8nCalls=[];n8nWorkflow={id:'fixtureWorkflow',name:'Synthetic n8n workflow',active:true,isArchived:false};n8nExecutions={data:[{id:'fixtureExecution',workflowId:'fixtureWorkflow',status:'success',startedAt:'2026-11-14T12:00:00Z',stoppedAt:'2026-11-14T12:01:00Z',waitTill:null}],nextCursor:null};
  directory = await mkdtemp(path.join(tmpdir(), 'hub-ui-'));
  hub = await createHub({ directory, port: 0, open: false,n8nClock:()=>n8nNow,n8nResolver:async()=>[{address:'93.184.216.34',family:4}],n8nFetcher:async(raw,init)=>{const url=new URL(raw);if(url.hostname!=='n8n.example.invalid')throw new Error('Unexpected synthetic n8n destination');n8nCalls.push({url:url.href,method:init.method});return new Response(JSON.stringify(n8nFault?{message:'Fixture read failure'}:url.pathname.includes('/workflows/')?n8nWorkflow:n8nExecutions),{status:n8nFault?503:200,headers:{'content-type':'application/json'}});}, oauthFetcher:async raw=>{const u=new URL(String(raw));const payload=u.hostname==='oauth2.googleapis.com'?{access_token:'fixture-only-access',refresh_token:'fixture-only-refresh',expires_in:3600,token_type:'Bearer',scope:'https://www.googleapis.com/auth/gmail.readonly'}:u.pathname.endsWith('/profile')?{emailAddress:'candidate@example.invalid'}:{messages:[]};return new Response(JSON.stringify(payload),{status:200,headers:{'content-type':'application/json'}});}, inboxRunner:async method=>method==='profile'?{emailAddress:'candidate@example.invalid'}:method==='list'?{messages:[]}:Promise.reject(new Error('Unexpected fixture mailbox read')), modelRunner: fixtureModelRunner });
  await page.goto(hub.launchUrl);
  await expect(page.getByRole('heading', { name: 'Home', exact:true })).toBeVisible();
});
test.afterEach(async ({page}) => { await page.close(); await hub?.close(); await rm(directory, { recursive: true, force: true });expect(pageErrors).toEqual([]); });

async function clickWorkspace(page) { await navigateTo(page,'Home'); await page.getByRole('button', { name: 'Go to Applications', exact: true }).click(); }

const section=workspaceSection;
async function chooseQuestion(page,id){const button=page.getByRole('navigation',{name:'Choose a saved question',exact:true}).locator(`[data-question-id=${JSON.stringify(id)}]`);if(!await button.isVisible()&&await page.getByRole('button',{name:'All saved questions',exact:true}).isVisible())await page.getByRole('button',{name:'All saved questions',exact:true}).click();await button.click();await expect(page.locator(`[data-attention-id=${JSON.stringify(id)}]`)).toBeVisible();}
async function openGuide(page){const guide=page.locator('.home-workflow-guide');if(!await guide.evaluate(element=>element.open))await guide.locator('summary').click();}

async function connections(page) {await navigateTo(page,'Automations');await page.getByRole('button',{name:'Connections',exact:true}).click();}
async function state(page) { return (await page.request.get(`${hub.baseUrl}/api/state`)).json(); }
async function snapshot(page,testInfo,name){
 const dismiss=page.getByRole('button',{name:'Dismiss notification',exact:true});if(await dismiss.count())await dismiss.click();
 await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
 await page.screenshot({path:testInfo.outputPath(name),fullPage:true});
}

test('linked DOCX resources hold previews while preserving the exact original', async ({page},testInfo)=>{
  const files={
    '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="doc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic Candidate. Built a simulated sensor prototype in twelve controlled tests.</w:t></w:r></w:p></w:body></w:document>',
    'word/_rels/document.xml.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="linkedImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://resource.example.invalid/private-image.png" TargetMode="External"/></Relationships>'
  };
  const bytes=Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,text])=>[name,strToU8(text)]))));
  await clickWorkspace(page);await section(page,'resumes');
  await page.getByRole('button',{name:'Import resumes',exact:true}).first().click();
  await page.locator('dialog input[type=file]').setInputFiles({name:'Linked resource.docx',mimeType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',buffer:bytes});
  await page.getByRole('button',{name:'Import 1 resume',exact:true}).click();
  await expect(page.getByText('1 imported',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Done',exact:true}).click();
  const resume=(await state(page)).resumes[0];expect(resume.renderStatus).toBe('needs_resource_review');expect(resume.text).toContain('simulated sensor prototype');
  const card=page.locator('.resume-card');await expect(card.getByText('Document resources need review',{exact:true})).toBeVisible();await expect(card.getByRole('link',{name:'Preview document',exact:true})).toHaveCount(0);await expect(card.locator('canvas')).toHaveCount(0);
  await expect(page.locator('.document-dossier')).toContainText(resume.renderError);await expect(page.locator('.document-dossier')).toContainText('Document resources need review');await expect(page.locator('.document-dossier canvas')).toHaveCount(0);await expect(page.locator('.document-dossier .document-preview-hold')).toContainText('Document resources need review');await expect(page.locator('.document-dossier').getByRole('link',{name:'Preview document',exact:true})).toHaveCount(0);
  const original=await page.request.get(`${hub.baseUrl}/api/files/${resume.id}?variant=original&download=1`);expect(original.ok()).toBe(true);expect(await original.body()).toEqual(bytes);
  await snapshot(page,testInfo,'linked-docx-desktop.png');await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await snapshot(page,testInfo,'linked-docx-mobile320.png');
});

test('imports, profile, rules, model opt-in and workflow linking use real persisted API', async ({ page }) => {
  await clickWorkspace(page);
  const applicationTab=page.getByRole('tab',{name:/Applications/});await applicationTab.focus();await page.keyboard.press('ArrowRight');await expect(page.locator('#workspace-tab-resumes')).toBeFocused();await expect(page.locator('#workspace-panel')).toHaveAttribute('aria-labelledby','workspace-tab-resumes');
  await section(page,'resumes');
  await page.getByRole('button', { name: 'Import resumes', exact: true }).first().click();
  await page.locator('dialog input[type=file]').setInputFiles({ name: 'Fixture candidate.md', mimeType: 'text/markdown', buffer: Buffer.from('# Candidate Example\n\n## Projects\n- Built a simulated sensor prototype using Python for 12 controlled tests.\n\n## Skills\nPython, signal processing') });
  await page.getByRole('button', { name: 'Import 1 resume', exact: true }).click();
  await expect(page.getByText('1 imported', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Fixture candidate.md', exact: true })).toBeVisible();
  await section(page,'applications');
  await page.getByRole('button', { name: 'Import jobs', exact: true }).click();
  await page.getByLabel('Job links or CSV').fill('https://boards.greenhouse.io/fixture/jobs/123\nhttps://job-boards.greenhouse.io/fixture/jobs/123?utm_source=test');
  await page.getByRole('button', { name: 'Import jobs', exact: true }).last().click();
  await expect(page.getByText('1 imported', { exact: true })).toBeVisible();
  await expect(page.getByText('1 duplicates skipped', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await section(page,'settings');
  await page.getByRole('button', { name: 'Edit profile', exact: true }).click();
  await page.getByLabel('Full name', { exact: true }).fill('Candidate Example');
  await page.getByLabel('Application email', { exact: true }).fill('candidate@example.invalid');
  await page.getByLabel('Availability', { exact: true }).fill('June 2027');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Review rules', exact: true }).click();
  await page.getByLabel('Maximum applications', { exact: true }).fill('5');
  await page.getByLabel('Maximum per employer', { exact: true }).fill('2');
  await page.getByLabel('Maximum reasoning calls', { exact: true }).fill('7');
  await page.getByLabel('Allowed application hosts', { exact: true }).fill('job-boards.greenhouse.io');
  await page.getByLabel('Allow unchanged finished resumes without individual review', { exact: false }).check();
  await page.getByRole('button', { name: 'Save rules', exact: true }).click();
  await expect.poll(async () => (await state(page)).campaign.rules.maxApplications).toBe(5);
  await expect.poll(async () => (await state(page)).campaign.rules.maxReasoningCalls).toBe(7);
  await expect.poll(async () => (await state(page)).campaign.rules.autoApproveUnchanged).toBe(true);
  const modelConfigure = page.getByRole('button', { name: 'Configure', exact: true });
  if (await modelConfigure.count()) {
    await modelConfigure.click();
    await page.getByLabel('Use my existing Codex CLI for private application reasoning', { exact: false }).check();
    await page.getByRole('button', { name: 'Check connection', exact: true }).click();
    await expect.poll(async () => (await state(page)).readiness.find(x => x.id === 'model').status).toBe('ready');
    await page.getByRole('button', { name: 'Done', exact: true }).click();
  }
  await navigateTo(page,'Automations');
  await page.getByRole('button', { name: 'Link an n8n workflow', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Existing test workflow');
  await page.getByLabel('Existing n8n workflow URL', { exact: true }).fill('http://localhost:5678/workflow/test-workflow');
  await page.getByRole('button', { name: 'Connect workflow', exact: true }).last().click();
  await expect(page.getByText('Existing test workflow', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Existing test workflow', exact: true })).toHaveAttribute('href', 'http://localhost:5678/workflow/test-workflow');
  expect((await state(page)).campaign.enabled).toBe(false);
  expect((await state(page)).automations.find(a=>a.name==='Existing test workflow').scheduleOwner).toBe('n8n');
});

test('isolated fixture campaign confirms only fixture receipts and resolves a parked employer question', async ({ page }, testInfo) => {
  await clickWorkspace(page);
  await section(page,'settings');
  await page.getByRole('button', { name: 'Open fixture workspace', exact: true }).click();
  await expect(page.getByText('Fixture workspace.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Enable campaign', exact: true }).click();
  await page.getByLabel('Enable this isolated fixture campaign.', { exact: true }).check();
  await page.getByRole('button', { name: 'Enable campaign', exact: true }).last().click();
  await expect.poll(async () => (await state(page)).summary.fixtureConfirmed, { timeout: 30_000 }).toBe(1);
  await expect.poll(async () => (await state(page)).decisions.filter(d=>d.code==='form_questions'&&d.state==='open').length, {timeout:30_000}).toBe(1);
  await navigateTo(page,'Needs You');
  await chooseQuestion(page,(await state(page)).decisions.find(d=>d.code==='form_questions'&&d.state==='open').id);
  await expect(page.getByRole('heading', { name: /A synthetic employer asks/ })).toBeVisible();
  await page.getByLabel('When can you start?', { exact: false }).fill('June 2027');
  await page.getByRole('button', { name: 'Save answer', exact: true }).click();
  await expect.poll(async () => (await state(page)).summary.fixtureConfirmed, { timeout: 30_000 }).toBe(2);
  expect((await state(page)).summary.confirmed).toBe(0);
  await clickWorkspace(page);
  await page.getByRole('button', {name:/Engineering intern Example Labs/}).click();
  await expect(page.getByRole('dialog', {name:'Example Labs',exact:true})).toBeVisible();
  await page.getByText('Check extracted resume text', {exact:true}).click();
  await expect(page.locator('.extracted-text')).toContainText('simulated sensor prototype');
  await expect(page.getByRole('link', {name:'Preview final document',exact:true})).toHaveAttribute('href', /variant=final/);
  await page.keyboard.press('Escape');
  await section(page,'outcomes');
  await expect(page.getByRole('button', { name: 'Fixture receipts 2', exact: false })).toBeVisible();
  await snapshot(page,testInfo,'outcomes-desktop.png');
  await page.getByRole('button', { name: 'Return to real workspace', exact: true }).click();
  await expect.poll(async () => (await state(page)).jobs.length).toBe(0);
  await expect(page.getByText('Fixture workspace.', { exact: true })).toHaveCount(0);
});

test('desktop and narrow screens retain working keyboard navigation and fit the viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1050 });
  const flowControlContrast=await page.locator('.home-next-actions .button.primary').first().evaluate(el=>{const rgb=s=>s.match(/[\d.]+/g).slice(0,3).map(Number);const lum=s=>rgb(s).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);const a=lum(getComputedStyle(el).color),b=lum(getComputedStyle(el).backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);});
  expect(flowControlContrast).toBeGreaterThanOrEqual(4.5);
  await snapshot(page,testInfo,'home-desktop.png');
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible();
  const dimensions = () => page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
  expect((await dimensions()).content).toBeLessThanOrEqual((await dimensions()).width);
  await page.setViewportSize({ width: 390, height: 844 });
  await snapshot(page,testInfo,'home-mobile.png');
  expect((await dimensions()).content).toBeLessThanOrEqual((await dimensions()).width);
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();
  await page.getByRole('button', { name: 'Add selected links', exact:true }).click();
  await expect(page.getByRole('dialog', { name: 'Import selected internships', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await clickWorkspace(page);
  await section(page,'settings');
  await expect(page.getByRole('heading', { name: 'Candidate profile', exact: true })).toBeVisible();
  expect((await dimensions()).content).toBeLessThanOrEqual((await dimensions()).width);
  await snapshot(page,testInfo,'settings-mobile.png');
  // Verify the browser assertion catches a known broken required state.
  const requiredHeading=page.getByRole('heading',{name:'Candidate profile',exact:true});
  await requiredHeading.evaluate(el=>{el.hidden=true;});
  let detected=false;try{await expect(requiredHeading).toBeVisible({timeout:150});}catch{detected=true;}
  expect(detected).toBe(true);
});

test('populated campaign desk, ledger inspector and long account holds remain readable', async ({ page },testInfo) => {
  await page.setViewportSize({width:1440,height:1100});
  await clickWorkspace(page);
  await section(page,'settings');
  await page.getByRole('button',{name:'Open fixture workspace',exact:true}).click();
  await expect(page.getByText('Fixture workspace.',{exact:true})).toBeVisible();
  const extraImport=await page.request.post(`${hub.baseUrl}/api/import/jobs`,{headers:{Origin:hub.baseUrl},data:{text:JSON.stringify([{url:'https://fixture.example.invalid/aurora/controls-intern',title:'Controls engineering intern',employer:'Aurora Instruments'},{url:'https://fixture.example.invalid/northstar/test-intern',title:'Test systems intern',employer:'Northstar Research'},{url:'https://fixture.example.invalid/fieldwork/embedded-intern',title:'Embedded systems intern',employer:'Fieldwork Devices'}])}});
  expect(extraImport.ok()).toBe(true);expect((await extraImport.json()).imported).toBe(3);
  await page.getByRole('button',{name:'Enable campaign',exact:true}).click();
  await page.getByLabel('Enable this isolated fixture campaign.',{exact:true}).check();
  await page.getByRole('button',{name:'Enable campaign',exact:true}).last().click();
  await expect.poll(async()=>{const s=await state(page);return s.summary.fixtureConfirmed>=1&&s.decisions.some(d=>d.code==='form_questions'&&d.state==='open');},{timeout:30_000}).toBe(true);
  await page.request.post(`${hub.baseUrl}/api/action`,{headers:{Origin:hub.baseUrl},data:{action:'pause'}});
  await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
  await navigateTo(page,'Home');
  await openGuide(page);await expect(page.locator('.home-work-summary>div').filter({hasText:'Selected roles'}).getByRole('button')).toHaveText('5');await expect(page.locator('.home-work-summary>div').filter({hasText:'Fixture receipts'}).getByRole('button')).toHaveText(String((await state(page)).summary.fixtureConfirmed));await expect(page.locator('.home-process-exceptions')).toContainText('Needs You');
  await snapshot(page,testInfo,'populated-home-desktop.png');
  await clickWorkspace(page);await section(page,'resumes');await expect(page.locator('.document-dossier .pdf-preview')).toHaveAttribute('data-rendered','true',{timeout:15_000});await section(page,'applications');
  await page.getByRole('button',{name:/Engineering intern Example Labs/}).click();
  await expect(page.getByRole('dialog',{name:'Example Labs',exact:true})).toBeVisible();
  await expect(page.locator('.application-inspector .pdf-preview')).toHaveAttribute('data-rendered','true',{timeout:15_000});
  await page.getByRole('button',{name:'Zoom in PDF',exact:true}).click();await expect(page.getByRole('button',{name:'Fit PDF to width',exact:true})).toContainText('125%');await page.getByRole('button',{name:'Fit PDF to width',exact:true}).click();
  await page.getByRole('tab',{name:'Posting',exact:true}).click();
  await expect(page.locator('.posting-text')).toContainText(/synthetic/i);
  await expect(page.getByText('Posting verified',{exact:true})).toBeVisible();
  await page.getByRole('tab',{name:'Document',exact:true}).click();
  await expect(page.locator('.application-inspector .pdf-preview')).toHaveAttribute('data-rendered','true',{timeout:15_000});
  await snapshot(page,testInfo,'populated-inspector-desktop.png');
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('.application-inspector .pdf-preview')).toHaveAttribute('data-rendered','true',{timeout:15_000});
  await page.evaluate(()=>{document.activeElement?.blur();window.scrollTo(0,0);});
  await expect(page.getByRole('dialog',{name:'Example Labs',exact:true})).toHaveAttribute('aria-modal','true');
  const mobileInspectorBox=await page.getByRole('dialog',{name:'Example Labs',exact:true}).boundingBox();expect(mobileInspectorBox.x).toBe(0);expect(mobileInspectorBox.width).toBe(390);
  for(const name of ['Close application inspector','Zoom in PDF','Fit PDF to width']){const box=await page.getByRole('button',{name,exact:true}).boundingBox();expect(box.width).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);expect(box.height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);}
  for(const key of ['Tab','Shift+Tab'])for(let i=0;i<24;i++){await page.keyboard.press(key);expect(await page.evaluate(()=>document.querySelector('.application-inspector').contains(document.activeElement))).toBe(true);}
  await page.screenshot({path:testInfo.outputPath('inspector-mobile.png'),fullPage:false});
  await page.keyboard.press('Escape');
  const ctx=hub.context(true);
  const waiting=ctx.store.list('job').find(job=>job.state==='needs_you');
  const review=await page.request.post(`${hub.baseUrl}/api/action`,{headers:{Origin:hub.baseUrl},data:{action:'reviewPackage',packageId:waiting.packageId,approved:false}});expect(review.ok()).toBe(true);
  await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
  await page.getByRole('button',{name:/Question internship Example Robotics/}).click();
  for(const name of ['Review 1 decision','Approve this document','Take over manually']){const box=await page.getByRole('button',{name,exact:true}).boundingBox();expect(box.width).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);expect(box.height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);}
  const postingTabBox=await page.getByRole('tab',{name:'Posting',exact:true}).boundingBox();expect(postingTabBox.width).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);expect(postingTabBox.height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);
  await page.keyboard.press('Escape');
  ctx.store.put('account',{id:'long-fixture-account',tenant:'example-employer-with-a-very-long-tenant-name.wd1.myworkdaysite.com/recruiting/long-company/careers',email:'alex@example.invalid',state:'awaiting_email_verification',nextAction:'Complete the scoped email verification request'});
  await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
  await navigateTo(page,'Needs You');
  await expect(page.getByText('example-employer-with-a-very-long-tenant-name.wd1.myworkdaysite.com/recruiting/long-company/careers',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await snapshot(page,testInfo,'populated-needs-mobile.png');
});

test('private connection forms save exact scope without exposing secret inputs', async ({page},testInfo)=>{
  const action=body=>page.request.post(`${hub.baseUrl}/api/action`,{headers:{Origin:hub.baseUrl},data:body});
  await action({action:'saveProfile',profile:{fullName:'Candidate Example',email:'candidate@example.invalid'}});
  await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
  await connections(page);
  await page.getByText('Employer credential vault',{exact:true}).click();
  const vaultSecret='fixture-only vault phrase 2026';
  await page.getByLabel('Create vault passphrase',{exact:true}).fill(vaultSecret);
  await page.getByLabel('Confirm vault passphrase',{exact:true}).fill(vaultSecret);
  await page.getByRole('button',{name:'Create vault',exact:true}).click();
  await expect.poll(async()=>(await state(page)).vault.unlocked).toBe(true);
  await expect(page.getByRole('button',{name:'Lock vault',exact:true})).toBeVisible();
  await page.getByText('Employer accounts',{exact:true}).last().click();
  await page.getByLabel('Employer tenant URL',{exact:true}).fill('https://careers.fixture.example/jobs');
  await page.getByLabel('Expected verification senders',{exact:true}).fill('verify@careers.fixture.example');
  await page.getByLabel('Allowed verification hosts',{exact:true}).fill('careers.fixture.example');
  await page.getByLabel('Expected verification subject',{exact:true}).fill('Confirm your application account');
  await page.getByRole('button',{name:'Save account rules',exact:true}).click();
  await expect.poll(async()=>(await state(page)).accountSettings.length).toBe(1);
  await page.getByText('Save an existing employer account',{exact:true}).click();
  await page.getByLabel('Existing account password',{exact:true}).fill('fixture-only-employer-secret');
  await page.getByRole('button',{name:'Save in private vault',exact:true}).click();
  await expect.poll(async()=>(await state(page)).vault.entryCount).toBe(1);
  await expect(page.getByLabel('Existing account password',{exact:true})).toHaveValue('');
  const serialized=JSON.stringify(await state(page));expect(serialized).not.toContain(vaultSecret);expect(serialized).not.toContain('fixture-only-employer-secret');
  await page.getByText('Application inbox',{exact:true}).click();
  await page.getByLabel('Application mailbox',{exact:true}).fill('candidate@example.invalid');
  await page.getByLabel('Trusted employer senders',{exact:true}).fill('verify@careers.fixture.example');
  await page.getByLabel('Employer message lookback',{exact:true}).fill('90');
  await page.getByLabel('Allow read-only Gmail access for application verification and outcomes',{exact:false}).check();
  await page.getByRole('button',{name:'Save inbox preferences',exact:true}).click();
  await expect.poll(async()=>(await state(page)).connections.find(c=>c.id==='inbox')?.enabled).toBe(true);
  await page.getByText('Advanced: existing operator Gmail connection',{exact:true}).click();
  await page.getByRole('button',{name:'Check Gmail connection',exact:true}).click();
  await expect.poll(async()=>(await state(page)).connections.find(c=>c.id==='inbox')?.verified).toBe(true);
  await page.getByRole('button',{name:'Check employer responses',exact:true}).click();
  await expect.poll(async()=>(await state(page)).events.some(e=>e.type==='inbox_checked')).toBe(true);
  await page.getByLabel('Google Desktop client ID',{exact:true}).fill('fixture-client-12345678.apps.googleusercontent.com');
  await page.getByLabel('Google Desktop client secret',{exact:true}).fill('fixture-google-client-secret');
  await page.getByLabel('This is my own Google Desktop application',{exact:false}).check();
  await page.getByRole('button',{name:'Save Google application',exact:true}).click();
  await expect.poll(async()=>(await state(page)).gmailOAuth.configured).toBe(true);
  await expect(page.getByLabel('Google Desktop client secret',{exact:true})).toHaveValue('');
  expect(JSON.stringify(await state(page))).not.toContain('fixture-google-client-secret');
  // Intercept Google navigation and token/profile transport. No real OAuth or mailbox is contacted.
  await page.route('https://accounts.google.com/**',async route=>{const u=new URL(route.request().url()),back=new URL(u.searchParams.get('redirect_uri'));back.searchParams.set('state',u.searchParams.get('state'));back.searchParams.set('code','fixture-authorization-code');await route.fulfill({status:302,headers:{location:back.toString()},body:''});});
  await page.getByRole('button',{name:'Connect Gmail',exact:true}).click();
  await expect.poll(async()=>(await state(page)).gmailOAuth.authorized,{timeout:15_000}).toBe(true);
  await expect.poll(()=>new URL(page.url()).pathname).toBe('/');
  await connections(page);
  await page.getByText('Employer credential vault',{exact:true}).click();
  await page.getByRole('button',{name:'Lock vault',exact:true}).click();
  await expect.poll(async()=>(await state(page)).vault.unlocked).toBe(false);
  await expect(page.getByLabel('Vault passphrase',{exact:true})).toHaveValue('');
  await snapshot(page,testInfo,'connections-desktop.png');
});

test('ordinary employer verification uses the dedicated ephemeral input',async({page})=>{
  const ctx=hub.context(false);ctx.store.put('verification_request',{id:'fixture-verification',accountId:'fixture-account',tenant:'careers.fixture.example',recipient:'candidate@example.invalid',purpose:'signup',allowedHosts:['careers.fixture.example'],state:'pending',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+300_000).toISOString()});
  await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
  await navigateTo(page,'Needs You');
  await chooseQuestion(page,'verify-fixture-verification');await page.setViewportSize({width:320,height:780});
  const verificationAction=page.getByRole('button',{name:'Continue this verification request',exact:true});const actionBox=await verificationAction.boundingBox(),cardBox=await page.locator('.verification-card').boundingBox(),padding=await page.locator('.verification-card').evaluate(element=>({left:parseFloat(getComputedStyle(element).paddingLeft),right:parseFloat(getComputedStyle(element).paddingRight)}));expect(actionBox.x).toBeGreaterThanOrEqual(cardBox.x+padding.left);expect(actionBox.x+actionBox.width).toBeLessThanOrEqual(cardBox.x+cardBox.width-padding.right);expect(actionBox.height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);
  await page.getByLabel('Email verification code',{exact:true}).fill('482913');
  await page.getByRole('button',{name:'Continue this verification request',exact:true}).click();
  await expect(page.getByLabel('Email verification code',{exact:true})).toHaveValue('');
  expect(JSON.stringify(await state(page))).not.toContain('482913');
  expect(ctx.store.list('decision').some(d=>String(d.answer||'').includes('482913'))).toBe(false);
});

test('a declined employer consent can be reconsidered with an explicit Boolean choice',async({page})=>{
 const ctx=hub.context(false);await ctx.engine.stop();
 const post=body=>page.request.post(`${hub.baseUrl}/api/action`,{headers:{Origin:hub.baseUrl},data:body});
 await post({action:'saveAccountSettings',url:'https://careers.fixture.example/jobs',expectedSenders:[],allowedHosts:['careers.fixture.example']});
 ctx.store.put('job',{id:'fixture-consent-job',url:'https://careers.fixture.example/jobs/one',identity:'main|fixture|consent',title:'Fixture internship',employer:'Fixture Employer',state:'needs_you',revision:0});
 ctx.store.put('account',{id:'fixture-consent-account',tenant:'careers.fixture.example',candidateId:'main',email:'candidate@example.invalid',state:'needs_consent'});
 ctx.store.put('decision',{id:'fixture-consent-decision',jobId:'fixture-consent-job',code:'account_consent_declined',state:'open',title:'Reconsider the exact employer consent',details:{accountId:'fixture-consent-account',questions:[{label:'I agree to the fixture employer application terms',kind:'consent',consentHash:'fixture-consent-hash'}]}});
 await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
 await navigateTo(page,'Needs You');
 await page.getByLabel('I agree to the fixture employer application terms',{exact:true}).selectOption('true');
 await page.getByRole('button',{name:'Save answer',exact:true}).click();
 await expect.poll(async()=>(await state(page)).decisions.find(d=>d.id==='fixture-consent-decision')?.state).toBe('resolved');
 expect(ctx.store.list('account_config')[0].consentApprovals['fixture-consent-hash'].answer).toBe(true);
});

const WRITING_LABEL='Describe your contribution to a technical project';
test('local waiting review prioritizes saved deadlines without losing unsaved reviewed answers',async({page},testInfo)=>{
 const ctx=hub.context(false);await ctx.engine.stop({releaseWorker:false});
 const clock=Date.now(),day=86400000,stamp=offset=>new Date(clock+offset).toISOString();
 const addJob=(id,deadline,extra={})=>ctx.store.put('job',{id,identity:`main|fixture|${id}`,employer:`Synthetic ${id}`,title:'Engineering internship',url:`https://fixture.example.invalid/${id}`,state:'needs_you',revision:0,...(deadline?{deadline,deadlineLabel:`Applications close ${deadline}`,deadlineUncertain:false}:{}),...extra});
 const addDecision=(id,job,extra={})=>ctx.store.put('decision',{id,jobId:job?.id,code:'form_questions',state:'open',title:id,createdAt:stamp(-3600000),details:{questions:[{label:`Availability for ${id}`,kind:'text',required:true}]},...extra});
 for(let i=1;i<=3;i++)addDecision(`Routine question ${i}`,addJob(`routine-${i}`));
 const writingJob=addJob('writing',stamp(12*3600000));
 const q={label:WRITING_LABEL,name:'project_response',tag:'textarea',kind:'writing_review',required:true,maxLength:1400,sourceUrl:writingJob.url};q.questionHash=questionFingerprint(q);
 addDecision('Review written answer',writingJob,{deadline:stamp(-2*day),details:{questions:[q,{label:'Preferred start month',name:'start',kind:'choice',type:'select',required:true,sourceUrl:writingJob.url,options:[{label:'June 2027',value:'06'},{label:'July 2027',value:'07'}]}]}});
 addDecision('Review passed deadline',addJob('passed',stamp(-3600000)));
 addDecision('Review upcoming deadline',addJob('upcoming',stamp(36*3600000)));
 addDecision('Review older question',addJob('aged'),{createdAt:stamp(-8*day)});
 const terminal=addJob('terminal',stamp(-3*day),{state:'submitted'}),shared=addJob('shared',stamp(6*3600000));
 addDecision('Review shared access',null,{jobIds:[terminal.id,shared.id]});
 const decisionBytes=ctx.store.list('decision').map(d=>JSON.stringify(d)),jobBytes=ctx.store.list('job').map(j=>JSON.stringify(j));
 await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await navigateTo(page,'Needs You');
 await chooseQuestion(page,'Review written answer');
 const answer=page.getByRole('textbox',{name:WRITING_LABEL,exact:true}),own='I built and evaluated a simulated sensor prototype using twelve controlled test cases.';
 await answer.fill(own);await page.getByRole('combobox',{name:'Preferred start month',exact:true}).selectOption({label:'July 2027'});
 const review=page.getByRole('checkbox',{name:`Approve exact answer for ${WRITING_LABEL}`,exact:true});await review.check();await answer.focus();
 const reviewed=reviewWaitingDecisions(ctx.store,{now:clock});expect(reviewed.attentionCount).toBe(5);
 const published=await state(page);expect(published.decisions.find(d=>d.id==='Review shared access').attention.jobIds).toEqual([shared.id]);
 await expect(page.getByRole('navigation',{name:'Choose a saved question',exact:true}).locator('button').first()).toContainText('Review passed deadline',{timeout:12000});
 await expect(answer).toHaveValue(own);await expect(review).toBeChecked();await expect(answer).toBeFocused();await expect(page.getByRole('combobox',{name:'Preferred start month',exact:true})).toHaveValue('July 2027');
 expect(ctx.store.list('decision').map(d=>JSON.stringify(d))).toEqual(decisionBytes);expect(ctx.store.list('job').map(j=>JSON.stringify(j))).toEqual(jobBytes);
 await expect(page.locator('.decision-card')).toHaveCount(8);await expect(page.locator('.decision-card-top .deadline')).toHaveCount(0);await expect(page.getByRole('navigation',{name:'Choose a saved question',exact:true}).getByText('Waiting at least 7 days',{exact:true})).toBeVisible();await chooseQuestion(page,'Review passed deadline');
 const passed=page.locator('.decision-card').filter({has:page.getByRole('heading',{name:'Review passed deadline',exact:true})});await expect(passed).toContainText('The employer portal has not been rechecked.');await expect(passed).toContainText('this computer’s clock');await expect(passed.locator('time')).toHaveAttribute('dateTime',stamp(-3600000));
 const disclosure=passed.locator('.attention-details'),toggle=disclosure.locator('summary');await expect(passed.locator('.attention-source')).not.toBeVisible();await toggle.focus();await page.keyboard.press('Enter');await expect(passed.locator('.attention-source')).toBeVisible();await expect(disclosure).toHaveAttribute('open','');expect((await disclosure.textContent()).match(/The employer portal has not been rechecked\./g)).toHaveLength(1);await passed.screenshot({path:testInfo.outputPath('waiting-details-desktop.png')});await toggle.click();await expect(passed.locator('.attention-source')).not.toBeVisible();await toggle.click();await expect(passed.locator('.attention-source')).toBeVisible();await toggle.click();await expect(passed.locator('.attention-source')).not.toBeVisible();
 await page.setViewportSize({width:1440,height:1050});await snapshot(page,testInfo,'waiting-needs-desktop.png');await page.setViewportSize({width:320,height:844});const summaryBox=await toggle.boundingBox();expect(summaryBox.height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await snapshot(page,testInfo,'waiting-needs-mobile320.png');
 await navigateTo(page,'Home');const home=page.locator('.home-question-list > button');await expect(home).toHaveCount(3);const priority=page.locator('.home-priority');await expect(priority).toContainText('Review passed deadline');const titles=await home.locator('.home-question-copy > strong').allTextContents();expect(titles.slice(0,2)).toEqual(['Review shared access','Review written answer']);await expect(priority.locator('time')).toHaveAttribute('dateTime',stamp(-3600000));await expect(page.locator('.home-recent').getByText('Waiting question needs review',{exact:true})).toHaveCount(3);await expect(page.locator('.home-recent')).not.toContainText('Automation hub');await expect(page.locator('.home-recent')).toContainText('Synthetic');
 await snapshot(page,testInfo,'waiting-home-mobile320.png');await page.setViewportSize({width:1440,height:1050});await snapshot(page,testInfo,'waiting-home-desktop.png');
 for(const [id,minutes] of [['short',5],['later',10],['expired',-1]])ctx.store.put('verification_request',{id:`waiting-${id}`,accountId:`fixture-${id}`,tenant:`careers.${id}.fixture.example`,recipient:'candidate@example.invalid',purpose:'signup',state:'pending',createdAt:stamp(-60000),expiresAt:stamp(minutes*60000)});
 await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();const requests=(await state(page)).verificationRequests;expect(requests.map(r=>r.id).sort()).toEqual(['waiting-later','waiting-short']);
 await expect(priority).toContainText('Verify employer email for careers.short.fixture.example');await expect(home.first()).toContainText('Verify employer email for careers.later.fixture.example');await expect(home.nth(1)).toContainText('Review passed deadline');await expect(priority.locator('time')).toHaveAttribute('dateTime',stamp(5*60000));await expect(page.getByText(/careers\.expired\.fixture\.example/)).toHaveCount(0);
 await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await snapshot(page,testInfo,'waiting-verification-home-mobile320.png');
 await navigateTo(page,'Needs You');await expect(page.locator('.verification-card')).toHaveCount(2);await expect(page.getByText('careers.expired.fixture.example',{exact:true})).toHaveCount(0);
});
async function decisionFixture(page,{prohibited=false,questions,requirements=false}={}) {
 await page.request.post(`${hub.baseUrl}/api/demo`,{headers:{Origin:hub.baseUrl},data:{enabled:true}});
 const ctx=hub.context(true);await ctx.engine.stop();ctx.model.runner=fixtureModelRunner;
 const source=ctx.store.list('job')[0];
 let job=ctx.store.put('job',{...source,posting:{sourceHash:'synthetic-writing-posting-v1',text:requirements?'Applicants must maintain a GPA of at least 3.0. Candidates must be available for the full summer.':`Engineering internship. Describe a simulated technical project.${prohibited?' Do not use AI to write your response.':''}`,sourceUrl:source.url},state:'needs_you'});
 const pkg=await ctx.resumes.select(job,ctx.store.list('resume')[0].id);
 job=ctx.store.put('job',{...ctx.store.get('job',job.id),packageId:pkg.id,state:'needs_you',decisionId:'writing-ui-decision'});
 const qs=questions||[{label:WRITING_LABEL,name:'project_response',tag:'textarea',kind:'writing_review',required:true,minLength:0,maxLength:1400,sourceUrl:job.url,existingAnswer:'I built a simulated sensor prototype in Python to evaluate signal quality. I measured 12 test cases in a controlled simulation. This was a prototype evaluated in simulation, and I would describe these limits clearly when discussing the project.'}];
 for(const q of qs){if(q.kind==='document')q.questionHash=supportingControlFingerprint(q);else if(['writing','writing_review'].includes(q.kind))q.questionHash=questionFingerprint(q);}
 let details={questions:qs},code='form_questions';
 if(requirements){const report=assessRequirements({job,profile:ctx.store.get('profile','main'),pkg});ctx.store.put('job',{...job,requirementLedger:report.entries});details={requirements:report.unresolvedMandatory,totalMandatoryPending:report.unresolvedMandatory.length,remainingAfterBatch:0};code='eligibility_review';}
 ctx.store.put('decision',{id:'writing-ui-decision',jobId:job.id,code,type:code,state:'open',title:requirements?'Review mandatory requirements':'Review the employer answers',details});
 await page.reload();await navigateTo(page,'Needs You');await chooseQuestion(page,'writing-ui-decision');
 return {ctx,job,pkg,questions:qs};
}

test('exact long writing review, evidence drafts and edit resets use the real service',async({page},testInfo)=>{
 const {ctx,job}=await decisionFixture(page);
 const answer=page.getByRole('textbox',{name:WRITING_LABEL,exact:true});
 expect((await answer.inputValue()).length).toBeGreaterThan(200);
 const save=page.getByRole('button',{name:'Save answer',exact:true}),review=page.getByRole('checkbox',{name:`Approve exact answer for ${WRITING_LABEL}`,exact:true});
 await expect(save).toBeDisabled();await review.check();await expect(save).toBeEnabled();
 await answer.fill((await answer.inputValue())+' I used Python.');await expect(review).not.toBeChecked();await expect(save).toBeDisabled();
 await page.getByText('Draft with assistance',{exact:true}).click();
 const draftButton=page.getByRole('button',{name:'Draft from my evidence',exact:true});await expect(draftButton).toBeDisabled();
 await page.getByRole('checkbox',{name:`Employer allows assistance for ${WRITING_LABEL}`,exact:true}).check();await draftButton.click();
 await expect(page.getByText('Draft for your review',{exact:true})).toBeVisible();await expect(review).not.toBeChecked();await expect(save).toBeDisabled();
 await expect(answer).toHaveValue('Built a simulated sensor prototype in Python to evaluate signal quality.');
 await expect(page.getByText('Your personal motivation for this employer was not supplied.',{exact:true})).toBeVisible();
 await page.getByText(/Sources supplied with this draft/).click();await expect(page.getByRole('link',{name:'Open preserved source',exact:true})).toBeVisible();
 expect(ctx.store.get('job',job.id).writingApprovals?.[WRITING_LABEL]).toBeUndefined();
 await snapshot(page,testInfo,'writing-desktop.png');
 await page.setViewportSize({width:320,height:844});
 const geometry=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth,controls:[...document.querySelectorAll('.writing-review,.writing-draft-tools > summary,.writing-draft-result .button')].filter(el=>el.getClientRects().length).map(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}))}));
 expect(geometry.width).toBeLessThanOrEqual(geometry.viewport);for(const box of geometry.controls)expect(box.height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);
 await snapshot(page,testInfo,'writing-mobile320.png');
 await review.check();await save.click();await expect.poll(()=>ctx.store.get('decision','writing-ui-decision').state).toBe('resolved');
 const persisted=ctx.store.get('job',job.id);expect(persisted.answers[WRITING_LABEL]).toBe('Built a simulated sensor prototype in Python to evaluate signal quality.');expect(persisted.writingApprovals[WRITING_LABEL].answerHash).toBeTruthy();
});

test('employer writing prohibition refuses drafting while exact manual review remains usable',async({page})=>{
 const {ctx,job}=await decisionFixture(page,{prohibited:true});
 await page.getByText('Draft with assistance',{exact:true}).click();await page.getByRole('checkbox',{name:`Employer allows assistance for ${WRITING_LABEL}`,exact:true}).check();await page.getByRole('button',{name:'Draft from my evidence',exact:true}).click();
 await expect(page.locator('.writing-draft-error')).toBeVisible();expect(ctx.store.list('writingDraft')).toHaveLength(0);
 await page.getByRole('textbox',{name:WRITING_LABEL,exact:true}).fill('I built a simulated sensor prototype in Python to evaluate signal quality.');
 await page.getByRole('checkbox',{name:`Employer allows assistance for ${WRITING_LABEL}`,exact:true}).uncheck();await page.getByRole('checkbox',{name:`Approve exact answer for ${WRITING_LABEL}`,exact:true}).check();await page.getByRole('button',{name:'Save answer',exact:true}).click();
 await expect.poll(()=>ctx.store.get('decision','writing-ui-decision').state).toBe('resolved');expect(ctx.store.get('job',job.id).writingApprovals[WRITING_LABEL]).toBeTruthy();
});

test('mandatory requirements preserve individual uncertain answers and permit a later scoped correction',async({page},testInfo)=>{
 const {ctx,job}=await decisionFixture(page,{requirements:true});
 const fields=page.locator('.requirement-question');await expect(fields).toHaveCount(2);
 await fields.nth(0).getByRole('radio',{name:'Eligible',exact:true}).check();await fields.nth(1).getByRole('radio',{name:'Uncertain',exact:true}).check();
 await page.getByRole('button',{name:'Save answer',exact:true}).click();await expect.poll(()=>ctx.store.get('job',job.id).requirementAnswers?.length).toBe(2);expect(ctx.store.get('decision','writing-ui-decision').state).toBe('open');
 await expect(fields).toHaveCount(1);await expect(fields.first()).toContainText('full summer');
 await page.setViewportSize({width:320,height:844});await snapshot(page,testInfo,'requirements-mobile320.png');
 await fields.first().getByRole('radio',{name:'Eligible',exact:true}).check();await page.getByRole('button',{name:'Save answer',exact:true}).click();await expect.poll(()=>ctx.store.get('decision','writing-ui-decision').state).toBe('resolved');
});

test('supporting document file review retains exact bytes and preserves another answer',async({page},testInfo)=>{
 const fileQuestion={label:'Academic transcript',name:'transcript',type:'file',kind:'document',accept:'.txt,.pdf',required:true,multiple:false,sourceUrl:'https://fixture.example.invalid/example/engineering-intern'};
 const {ctx,job}=await decisionFixture(page,{questions:[fileQuestion,{label:'Start date',name:'start',kind:'text',required:true}]});
 await page.getByRole('textbox',{name:'Start date',exact:true}).fill('June 2027');
 await page.evaluate(()=>{const original=URL.createObjectURL;URL.createObjectURL=function(blob){window.__syntheticSupportingPreviewMime=blob.type;return original.call(this,blob);};});
 await page.getByLabel('File for Academic transcript',{exact:true}).setInputFiles({name:'Unsafe fixture.html',mimeType:'text/html',buffer:Buffer.from('<script>window.syntheticUnsafePreview=true</script>')});await expect(page.getByRole('link',{name:'Open selected file',exact:true})).toHaveCount(0);await expect(page.locator('.supporting-question [role=alert]')).toContainText('cannot be previewed');await expect(page.getByRole('button',{name:'Retain reviewed supporting file',exact:true})).toBeDisabled();
 await page.getByLabel('File for Academic transcript',{exact:true}).setInputFiles({name:'Fixture transcript.txt',mimeType:'text/html',buffer:Buffer.from(`Alex Example
Synthetic academic transcript fixture
No real academic record.`)});
 const retain=page.getByRole('button',{name:'Retain reviewed supporting file',exact:true});await expect(retain).toBeDisabled();await expect(page.getByRole('link',{name:'Open selected file',exact:true})).toHaveAttribute('href',/^blob:/);expect(await page.evaluate(()=>window.__syntheticSupportingPreviewMime)).toBe('text/plain');
 await page.getByRole('checkbox',{name:'I reviewed this exact file for this candidate, employer and question',exact:false}).check();await retain.click();
 await expect(page.getByText('Retained file',{exact:true})).toBeVisible();await expect(page.getByRole('textbox',{name:'Start date',exact:true})).toHaveValue('June 2027');
 const preview=page.getByRole('link',{name:'Preview retained document',exact:true});const response=await page.request.get(new URL(await preview.getAttribute('href'),hub.baseUrl).href);expect(response.status()).toBe(200);expect(response.headers()['content-type']).toBe('application/pdf');
 const download=await page.request.get(new URL(await page.getByRole('link',{name:'Download exact original',exact:true}).getAttribute('href'),hub.baseUrl).href);expect((await download.body()).toString()).toContain('No real academic record.');
 await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await snapshot(page,testInfo,'supporting-mobile320.png');
 await page.reload();await navigateTo(page,'Needs You');await chooseQuestion(page,'writing-ui-decision');await page.getByRole('button',{name:'Use this reviewed file',exact:true}).click();await page.getByRole('textbox',{name:'Start date',exact:true}).fill('June 2027');
 await page.getByRole('button',{name:'Save answer',exact:true}).click();await expect.poll(()=>ctx.store.get('decision','writing-ui-decision').state).toBe('resolved');expect(ctx.store.get('job',job.id).answers['Academic transcript'].documentId).toMatch(/^supporting-/);
 const previous=ctx.store.get('decision','writing-ui-decision');const changed={...fileQuestion,multiple:true};changed.questionHash=supportingControlFingerprint(changed);ctx.store.put('decision',{...previous,state:'open',details:{questions:[changed]}});ctx.store.put('job',{...ctx.store.get('job',job.id),state:'needs_you'});await page.reload();await navigateTo(page,'Needs You');await chooseQuestion(page,'writing-ui-decision');await expect(page.getByText('Previous supporting file',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Use this reviewed file',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Save answer',exact:true})).toBeDisabled();
});


test('late writing drafts preserve edits and persisted drafts require an explicit current choice',async({page})=>{
 const {ctx,job}=await decisionFixture(page);let releaseDraft,startedDraft;const started=new Promise(resolve=>startedDraft=resolve),gate=new Promise(resolve=>releaseDraft=resolve);
 ctx.model.runner=async input=>{if(input.task==='draftWriting'){startedDraft();await gate;}return fixtureModelRunner(input);};
 await page.getByText('Draft with assistance',{exact:true}).click();await page.getByRole('checkbox',{name:`Employer allows assistance for ${WRITING_LABEL}`,exact:true}).check();await page.getByRole('button',{name:'Draft from my evidence',exact:true}).click();await started;
 const answer=page.getByRole('textbox',{name:WRITING_LABEL,exact:true});const own='I measured 12 test cases in a controlled simulation.';await answer.fill(own);releaseDraft();
 await expect(page.getByText('Your answer changed while the draft was being prepared. Your current text has been kept.',{exact:true})).toBeVisible();await expect(answer).toHaveValue(own);await expect(page.getByRole('checkbox',{name:`Approve exact answer for ${WRITING_LABEL}`,exact:true})).not.toBeChecked();
 await page.reload();await navigateTo(page,'Needs You');await chooseQuestion(page,'writing-ui-decision');await expect(page.getByText('Draft for your review',{exact:true})).toBeVisible();await expect(answer).not.toHaveValue('Built a simulated sensor prototype in Python to evaluate signal quality.');
 await page.getByRole('button',{name:'Use this draft',exact:true}).click();await expect(answer).toHaveValue('Built a simulated sensor prototype in Python to evaluate signal quality.');
 ctx.store.put('job',{...ctx.store.get('job',job.id),posting:{...job.posting,sourceHash:'synthetic-new-posting'}});await page.reload();await navigateTo(page,'Needs You');await chooseQuestion(page,'writing-ui-decision');await expect(page.getByText('Previous draft',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Use this draft',exact:true})).toHaveCount(0);
});

test('native employer choices preserve exact labels and optional blank without invented options',async({page},testInfo)=>{
 const {ctx,job}=await decisionFixture(page,{questions:[{label:'Current GPA range',name:'gpa',tag:'select',type:'select',sourceUrl:'https://fixture.example.invalid/example/engineering-intern',kind:'choice',required:true,canLeaveBlank:false,options:[{label:'3.0 to 3.49',value:'gpa-3'},{label:'3.5 to 4.0',value:'gpa-4'},{label:'Prefer not to disclose',value:'decline'}]},{label:'Earliest start month',name:'start',tag:'select',type:'select',sourceUrl:'https://fixture.example.invalid/example/engineering-intern',kind:'choice',required:false,canLeaveBlank:true,options:[{label:'June 2027',value:'06'},{label:'July 2027',value:'07'}]}]});
 const gpa=page.getByRole('combobox',{name:'Current GPA range',exact:true}),start=page.getByRole('combobox',{name:'Earliest start month',exact:true});
 await expect(gpa.locator('option')).toHaveText(['Choose an answer','3.0 to 3.49','3.5 to 4.0','Prefer not to disclose']);await expect(page.getByRole('button',{name:'Save answer',exact:true})).toBeDisabled();
 await gpa.selectOption({label:'3.0 to 3.49'});await start.selectOption({label:'June 2027'});await page.locator('.choice-question').nth(1).getByRole('checkbox',{name:'Leave this optional question blank',exact:true}).check();await expect(start).toBeDisabled();
 await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect((await gpa.boundingBox()).height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);await snapshot(page,testInfo,'choices-mobile320.png');
 const saved=page.waitForResponse(response=>response.url().endsWith('/api/action')&&response.request().postDataJSON()?.action==='resolveDecision');await page.getByRole('button',{name:'Save answer',exact:true}).click();const response=await saved;expect(response.status(),await response.text()).toBe(200);await expect.poll(()=>ctx.store.get('decision','writing-ui-decision').state).toBe('resolved');expect(ctx.store.get('job',job.id).answers['Current GPA range']).toBe('3.0 to 3.49');expect(ctx.store.get('job',job.id).answers['Earliest start month']).toBeNull();
});

test('a committed draft arriving after posting or native question change cannot replace current writing',async({page})=>{
 for(const change of ['posting','question']){
  const {ctx,job}=await decisionFixture(page);
  const answer=page.getByRole('textbox',{name:WRITING_LABEL,exact:true}),before=await answer.inputValue();
  const intercept=async route=>{if(route.request().postDataJSON()?.action!=='draftWriting'){await route.continue();return;}const response=await route.fetch();if(change==='posting')ctx.store.put('job',{...ctx.store.get('job',job.id),posting:{...job.posting,sourceHash:'synthetic-changed-after-commit'}});else{const decision=ctx.store.get('decision','writing-ui-decision');decision.details.questions[0].maxLength=1399;decision.details.questions[0].questionHash=questionFingerprint(decision.details.questions[0]);ctx.store.put('decision',decision);}await route.fulfill({response});};
  await page.route('**/api/action',intercept);
  await page.getByText('Draft with assistance',{exact:true}).click();await page.getByRole('checkbox',{name:`Employer allows assistance for ${WRITING_LABEL}`,exact:true}).check();await page.getByRole('button',{name:'Draft from my evidence',exact:true}).click();
  await expect(page.getByText('Previous draft',{exact:true})).toBeVisible();await expect(answer).toHaveValue(before);await expect(page.getByRole('button',{name:'Use this draft',exact:true})).toHaveCount(0);await expect(page.getByRole('checkbox',{name:`Approve exact answer for ${WRITING_LABEL}`,exact:true})).not.toBeChecked();
  await page.unroute('**/api/action',intercept);await page.reload();await navigateTo(page,'Needs You');await chooseQuestion(page,'writing-ui-decision');await expect(page.getByText('Previous draft',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Use this draft',exact:true})).toHaveCount(0);
 }
});

test('supporting file review cannot cross a native question change during reading or response arrival',async({page})=>{
 for(const phase of ['reading','arrival']){
  const q={label:'Academic transcript',name:'transcript',type:'file',kind:'document',accept:'.txt,.pdf',required:true,multiple:false,sourceUrl:'https://fixture.example.invalid/example/engineering-intern'};
  const {ctx}=await decisionFixture(page,{questions:[q]});let attachmentRequests=0;
  const observe=request=>{if(request.url().endsWith('/api/action')&&request.postDataJSON()?.action==='attachSupportingDocument')attachmentRequests++;};page.on('request',observe);
  const changeQuestion=()=>{const decision=ctx.store.get('decision','writing-ui-decision'),question={...decision.details.questions[0],multiple:true};question.questionHash=supportingControlFingerprint(question);ctx.store.put('decision',{...decision,details:{questions:[question]}});};
  const intercept=async route=>{if(route.request().postDataJSON()?.action!=='attachSupportingDocument'){await route.continue();return;}const response=await route.fetch();changeQuestion();await route.fulfill({response});};
  if(phase==='reading')await page.evaluate(()=>{const original=FileReader.prototype.readAsDataURL;window.restoreFileReader=()=>FileReader.prototype.readAsDataURL=original;FileReader.prototype.readAsDataURL=function(file){window.fileReadStarted=true;window.releaseFileRead=()=>original.call(this,file);};});else await page.route('**/api/action',intercept);
  await page.getByLabel('File for Academic transcript',{exact:true}).setInputFiles({name:'Fixture transcript.txt',mimeType:'text/plain',buffer:Buffer.from('Alex Example synthetic transcript fixture.')});await page.getByRole('checkbox',{name:'I reviewed this exact file for this candidate, employer and question',exact:false}).check();await page.getByRole('button',{name:'Retain reviewed supporting file',exact:true}).click();
  if(phase==='reading'){await expect.poll(()=>page.evaluate(()=>window.fileReadStarted===true)).toBe(true);changeQuestion();await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await expect(page.getByRole('checkbox',{name:'I reviewed this exact file for this candidate, employer and question',exact:false})).not.toBeChecked();await page.evaluate(()=>{window.releaseFileRead();window.restoreFileReader();});}
  await expect(page.locator('.supporting-question [role=alert]')).toBeVisible();await expect(page.getByText('Retained file',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Save answer',exact:true})).toBeDisabled();
  expect(attachmentRequests).toBe(phase==='reading'?0:1);page.off('request',observe);if(phase==='arrival')await page.unroute('**/api/action',intercept);
 }
});


test('optional n8n observer saves privately and distinguishes observed, stale, unavailable and empty history',async({page},testInfo)=>{
 await connections(page);await page.getByText('Connect read-only n8n status',{exact:true}).click();
 await expect(page.getByRole('button',{name:'Save read-only connection',exact:true})).toBeDisabled();await expect(page.getByLabel('n8n API key',{exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Open vault settings',exact:true}).click();const phrase='synthetic n8n vault passphrase';await page.getByLabel('Create vault passphrase',{exact:true}).fill(phrase);await page.getByLabel('Confirm vault passphrase',{exact:true}).fill(phrase);await page.getByRole('button',{name:'Create vault',exact:true}).click();await expect.poll(async()=>(await state(page)).vault.unlocked).toBe(true);
 await navigateTo(page,'Automations');await page.getByRole('button',{name:'Link an n8n workflow',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('Synthetic n8n workflow');await page.getByLabel('Existing n8n workflow URL',{exact:true}).fill('https://n8n.example.invalid/workflow/fixtureWorkflow');await page.getByRole('button',{name:'Connect workflow',exact:true}).last().click();
 const workflow=page.locator('.external-workflow');await expect(workflow.getByText('Not observed',{exact:true})).toBeVisible();await expect(workflow.getByRole('button',{name:'Refresh status',exact:true})).toBeDisabled();
 await connections(page);await page.getByText('Connect read-only n8n status',{exact:true}).click();const key='synthetic-n8n-key-only';await page.getByLabel('n8n instance URL',{exact:true}).fill('https://n8n.example.invalid');await page.getByLabel('n8n API key',{exact:true}).fill(key);await expect(page.getByRole('button',{name:'Save read-only connection',exact:true})).toBeDisabled();await page.getByRole('checkbox',{name:'Allow read-only access to my selected n8n workflows',exact:true}).check();await page.getByRole('button',{name:'Save read-only connection',exact:true}).click();
 await expect.poll(async()=>(await state(page)).n8n.configured).toBe(true);await expect(page.getByLabel('n8n API key',{exact:true})).toHaveValue('');expect(n8nCalls).toHaveLength(0);expect(JSON.stringify(await state(page))).not.toContain(key);expect((await state(page)).campaign.enabled).toBe(false);
 await navigateTo(page,'Automations');await workflow.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(workflow.getByText('Active in n8n',{exact:true})).toBeVisible();await workflow.getByText('View observed status and history',{exact:true}).click();await expect(workflow.getByText('Execution fixtureExecution',{exact:true})).toBeVisible();expect(n8nCalls).toHaveLength(2);expect(n8nCalls.every(call=>call.method==='GET')).toBe(true);expect(n8nCalls[1].url).toContain('includeData=false');
 await snapshot(page,testInfo,'n8n-observed-desktop.png');
 n8nNow+=6*60*1000;await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await expect(workflow.getByText('Stale observation',{exact:true})).toBeVisible();
 n8nFault=true;await workflow.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(workflow.getByText('Status unavailable',{exact:true})).toBeVisible();await expect(workflow.getByText(/previous observation is retained below/)).toBeVisible();await expect(workflow.getByText('Execution fixtureExecution',{exact:true})).toBeVisible();
 n8nFault=false;n8nNow+=11*1000;n8nWorkflow={...n8nWorkflow,active:false};n8nExecutions={data:[],nextCursor:null};await workflow.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(workflow.getByText('Inactive in n8n',{exact:true})).toBeVisible();await expect(workflow.getByText('No executions were returned in this bounded history view.',{exact:true})).toBeVisible();await expect(workflow.getByText(/whether a workflow is currently running/)).toBeVisible();
 n8nNow+=11*1000;n8nWorkflow={...n8nWorkflow,isArchived:true};await workflow.getByRole('button',{name:'Refresh status',exact:true}).click();await expect(workflow.getByText('Archived in n8n',{exact:true})).toBeVisible();
 await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);for(const control of await page.locator('.external-workflow button,.n8n-connection button,.n8n-connection summary').all()){if(await control.isVisible())expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);}await snapshot(page,testInfo,'n8n-archived-mobile320.png');
 const action=body=>page.request.post(`${hub.baseUrl}/api/action`,{headers:{Origin:hub.baseUrl},data:body});await action({action:'vaultLock'});await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await expect(workflow.getByText('Vault locked',{exact:true})).toBeVisible();await expect(workflow.getByRole('button',{name:'Refresh status',exact:true})).toBeDisabled();expect((await state(page)).automations.find(item=>item.executor==='n8n').scheduleOwner).toBe('n8n');await navigateTo(page,'Home');const observedEvent=page.locator('.home-recent li').filter({has:page.getByText('N8n observed',{exact:true})}).first();await expect(observedEvent).toContainText('Synthetic n8n workflow');
});


test('writing source review shows human project phase and exact fixed qualifier passages',async({page},testInfo)=>{
 const {ctx}=await decisionFixture(page);
 const text='# Alex Example\n\n## Projects\n### Measurement study\nSimulation-only phase\n- Measured 12 cases in Python.\n\n## Skills\nPython\n';
 const imported=await page.request.post(`${hub.baseUrl}/api/import/resumes`,{headers:{Origin:hub.baseUrl},data:{files:[{name:'Synthetic phase evidence.md',content:Buffer.from(text).toString('base64'),mega:true}]}});expect(imported.status()).toBe(200);
 ctx.model.runner=async input=>{if(input.task!=='draftWriting')return fixtureModelRunner(input);const source=input.sourceCatalog.find(item=>item.text.includes('Measured 12 cases in Python')&&item.supportingContext?.includes('Simulation-only phase'));return {sentences:[{text:'In the simulation-only phase, I measured 12 cases in Python.',sourceIds:[source.id]}],missingFacts:[],explanation:'Synthetic fixture: preserves the fixed phase qualifier beside the child measurement.'};};
 await page.getByText('Draft with assistance',{exact:true}).click();await page.getByRole('checkbox',{name:`Employer allows assistance for ${WRITING_LABEL}`,exact:true}).check();await page.getByRole('button',{name:'Draft from my evidence',exact:true}).click();await expect(page.getByText('Draft for your review',{exact:true})).toBeVisible();await page.getByText(/Sources supplied with this draft/).click();
 const source=page.locator('.writing-source');await expect(source.getByText('Measurement study / Simulation-only phase',{exact:true})).toBeVisible();await expect(source.locator('blockquote').filter({hasText:'Simulation-only phase'})).toBeVisible();await expect(source).not.toContainText('scope:');await expect(page.getByRole('checkbox',{name:`Approve exact answer for ${WRITING_LABEL}`,exact:true})).not.toBeChecked();
 await snapshot(page,testInfo,'writing-fixed-context-desktop.png');await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await snapshot(page,testInfo,'writing-fixed-context-mobile320.png');
});


test('quoted employer cap review and reached decisions preserve waiting work or explicit manual control',async({page},testInfo)=>{
 for(const scenario of ['review','reached']){
  const {ctx,job:initial}=await decisionFixture(page);
  const quote=`You may submit only one internship application to Example Labs${scenario==='review'?' per hiring cycle':''}.`;
  const job=ctx.store.put('job',{...ctx.store.get('job',initial.id),posting:{...initial.posting,text:quote,title:initial.title,employer:initial.employer,sourceUrl:initial.url},state:'needs_you'});
  ctx.store.put('job',{...job,id:`synthetic-reservation-${scenario}`,identity:`${job.identity}|prior-${scenario}`,url:`https://fixture.example.invalid/example/prior-${scenario}`,title:'Synthetic prior role',posting:null,state:'uncertain',decisionId:null});
  const report=assessApplicationLimits({job,profile:ctx.store.get('profile','main'),jobs:ctx.store.list('job'),attempts:ctx.store.list('run'),userCap:3});expect(scenario==='review'?report.needsReview:report.projectedCount>report.effectiveCap).toBe(true);
  ctx.store.put('decision',{id:'writing-ui-decision',jobId:job.id,code:`application_limit_${scenario==='review'?'review':'reached'}`,type:'application_limit',state:'open',title:scenario==='review'?'Review the employer application-limit scope':'The employer application limit is reached',details:{report}});
  await page.reload();await navigateTo(page,'Needs You');await chooseQuestion(page,'writing-ui-decision');const card=page.locator('.decision-card');
  await expect(card.getByText(quote,{exact:true})).toBeVisible();await expect(card.getByRole('link',{name:'Read source posting',exact:true})).toHaveAttribute('href',job.url);await expect(card.getByRole('button',{name:'Retry after fixing',exact:true})).toHaveCount(0);await expect(card.locator('.limit-summary dd').first()).toHaveText(String(report.effectiveCap));expect(ctx.store.get('job',job.id).state).toBe('needs_you');
  await card.getByText(`Applications reserving this employer’s capacity (${report.reservations.length})`,{exact:true}).click();await expect(card.locator('.limit-reservations')).toContainText('Synthetic prior role');
  if(scenario==='review')await snapshot(page,testInfo,'application-cap-review-desktop.png');
  await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await snapshot(page,testInfo,`application-cap-${scenario}-mobile320.png`);
  await card.getByRole('radio',{name:'Continue this application manually',exact:true}).check();await card.getByRole('button',{name:'Save answer',exact:true}).click();await expect.poll(()=>ctx.store.get('job',job.id).state).toBe('manual');expect(ctx.store.get('decision','writing-ui-decision').state).toBe('resolved');
 }
});


test('shared Home keeps actual work, exact questions and connections reachable',async({page},testInfo)=>{
 await expect(page.getByRole('heading',{name:'Home',exact:true})).toBeVisible();
 await openGuide(page);await expect(page.locator('.home-process-steps li')).toHaveText(['Select rolesBrowse and choose internships','Check requirementsPosting, eligibility and rules','Prepare résuméYour exact application document','ApplyOnly under your enabled rules','Confirm receiptMatch evidence from the employer']);
 await expect(page.locator('.home-work-summary dt')).toHaveText(['Selected roles','Finished résumés','Confirmed receipts']);await expect(page.locator('.home-work-summary dd')).toHaveText(['0','0','0']);await expect(page.locator('.internship-automation')).toContainText('Campaign off');await expect(page.locator('.home-process-exceptions')).toHaveCount(0);
 await navigateTo(page,'Automations');await page.getByRole('button',{name:'Link an n8n workflow',exact:true}).click();await page.getByLabel('Name',{exact:true}).fill('Synthetic shared workflow');await page.getByLabel('Existing n8n workflow URL',{exact:true}).fill('https://n8n.example.invalid/workflow/sharedFixture');await page.getByRole('button',{name:'Connect workflow',exact:true}).click();
 await navigateTo(page,'Home');const linked=page.locator('.external-automation');await expect(linked).toHaveCount(1);await expect(linked.getByRole('link',{name:'Open in n8n'})).toHaveAttribute('href','https://n8n.example.invalid/workflow/sharedFixture');expect((await state(page)).campaign.enabled).toBe(false);
 const ctx=hub.context(false);await ctx.engine.stop();await page.request.post(`${hub.baseUrl}/api/import/jobs`,{headers:{Origin:hub.baseUrl},data:{text:JSON.stringify([{url:'https://job-boards.greenhouse.io/sharedfixture/jobs/123',title:'Synthetic selected role',employer:'Synthetic employer'}])}});const job=ctx.store.list('job')[0];ctx.store.put('job',{...job,state:'needs_you'});ctx.store.put('decision',{id:'shared-home-decision',jobId:job.id,code:'account_access',state:'open',title:'Synthetic access review'});ctx.store.put('decision',{id:'superseded-home-decision',jobId:job.id,code:'package_review',state:'superseded',title:'Obsolete synthetic document review'});await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();
 await openGuide(page);await expect(page.locator('.home-work-summary>div').filter({hasText:'Selected roles'}).getByRole('button')).toHaveText('1');await expect(page.locator('.home-process-exceptions')).toContainText('Apply');await expect(page.locator('.home-question-list')).toContainText('Synthetic access review');await expect(page.locator('.home-question-list')).not.toContainText('Obsolete synthetic document review');
 await snapshot(page,testInfo,'shared-home-populated-desktop.png');
 for(const width of [768,320,390]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const question=page.locator('.home-process-exceptions button');await question.focus();await expect(question).toBeFocused();const box=await question.boundingBox(),nav=await page.locator('.studio-topbar').boundingBox();expect(box.y).toBeGreaterThanOrEqual(nav.y+nav.height-1);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);expect(box.y+box.height).toBeLessThanOrEqual(844);await snapshot(page,testInfo,`shared-home-mobile${width}.png`);}
 await page.locator('.home-process-exceptions button').click();await expect(page.getByRole('heading',{name:'Synthetic access review',exact:true})).toBeFocused();await expect(page.locator('.decision-card')).toHaveCount(1);await expect(page.getByText('Obsolete synthetic document review',{exact:true})).toHaveCount(0);
 await connections(page);await expect(page.getByRole('heading',{name:'Connections',exact:true})).toBeVisible();expect(new URL(page.url()).hash).toBe('#connections');await page.reload();await expect(page.getByRole('heading',{name:'Connections',exact:true})).toBeVisible();
});

test('Home places each registered workflow beside its own observed status without claiming execution',async({page},testInfo)=>{
 const ctx=hub.context(false);await ctx.engine.stop({releaseWorker:false});
 const action=async data=>{const response=await page.request.post(`${hub.baseUrl}/api/action`,{headers:{Origin:hub.baseUrl},data});expect(response.status(),await response.text()).toBe(200);return response.json();};
 await action({action:'vaultSetup',passphrase:'synthetic home map vault phrase'});await action({action:'configureN8nObserver',baseUrl:'https://n8n.example.invalid',apiKey:'synthetic-map-key',confirmed:true});const revision=ctx.store.get('connection','n8n').revision;
 const fixtures=[['active','Daily research digest',true,false],['unavailable','Document archive',false,false],['stale','Weekly reading review',false,false],['archived','Past project summary',false,true]];
 for(const [kind,name,active,isArchived] of fixtures){const item=await action({action:'registerWorkflow',name,url:`https://n8n.example.invalid/workflow/${kind}Fixture`});ctx.store.put('automation',{...item,observationStatus:kind==='unavailable'?'unavailable':'observed',lastObservationAttemptAt:new Date(n8nNow).toISOString(),lastObservationErrorCode:kind==='unavailable'?'N8N_UNAVAILABLE':null,observation:{connectionRevision:revision,observedAt:new Date(n8nNow-(kind==='stale'?360000:0)).toISOString(),workflow:{id:`${kind}Fixture`,name,active,isArchived},executions:[],historyCoverage:'visible_non_running_executions',metadataOnly:true}});}
 await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await expect(page.locator('.home-automation')).toHaveCount(5);
 const row=name=>page.locator('.external-automation').filter({has:page.getByRole('heading',{name,exact:true})});
 await expect(row('Daily research digest')).toContainText('Active in n8n');await expect(row('Document archive')).toContainText('Status unavailable');await expect(row('Weekly reading review')).toContainText('Stale observation');await expect(row('Past project summary')).toContainText('Archived in n8n');for(const item of await page.locator('.external-automation').all())await expect(item).not.toContainText('Running');expect(n8nCalls).toHaveLength(0);
 const archive=row('Document archive');await expect(archive.getByRole('link',{name:'Open in n8n'})).toHaveAttribute('href','https://n8n.example.invalid/workflow/unavailableFixture');await archive.getByText('View observed status and history',{exact:true}).click();await expect(archive.getByText(/previous observation is retained below/)).toBeVisible();await expect(page.getByRole('button',{name:/Run|Execute|Activate|Retry workflow|Pause workflow/,exact:true})).toHaveCount(0);expect(n8nCalls).toHaveLength(0);
 await snapshot(page,testInfo,'automation-rows-observed-desktop.png');
 for(const width of [320,390,768]){await page.setViewportSize({width,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);const link=row('Past project summary').getByRole('link',{name:'Open in n8n'});await link.focus();await expect(link).toBeFocused();const box=await link.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);expect(box.height).toBeGreaterThanOrEqual(TOUCH_TARGET_FLOOR);await snapshot(page,testInfo,`automation-rows-mobile${width}.png`);}
 expect((await state(page)).campaign.enabled).toBe(false);
 await page.route('**/api/state',route=>route.abort('failed'));await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await expect(page.locator('.offline-banner')).toContainText('The workspace could not be confirmed');await expect(page.locator('#main')).toHaveAttribute('inert','');await expect(page.locator('.home-stale-note')).toBeVisible();await page.unroute('**/api/state');await page.getByRole('button',{name:'Refresh dashboard',exact:true}).click();await expect(page.locator('#main')).not.toHaveAttribute('inert','');await expect(page.locator('.home-stale-note')).toHaveCount(0);
});

test('native Gmail setup uses only the fixed browser handoff and hash connections route',async({page},testInfo)=>{
 let oauthRequests=0;page.on('request',request=>{if(request.url().endsWith('/api/action')&&request.postDataJSON()?.action==='beginGmailAuthorization')oauthRequests++;});
 await page.addInitScript(()=>{window.__nativeHubMessages=[];window.webkit={messageHandlers:{hub:{postMessage:message=>window.__nativeHubMessages.push(message)}}};});await page.goto(`${hub.baseUrl}/#connections`);await page.reload();await expect(page.getByRole('heading',{name:'Connections',exact:true})).toBeVisible();await page.getByText('Application inbox',{exact:true}).click();await page.getByRole('button',{name:'Open Gmail setup in browser',exact:true}).click();expect(await page.evaluate(()=>window.__nativeHubMessages)).toEqual([{action:'openBrowserConnections'}]);expect(oauthRequests).toBe(0);await expect(page.getByRole('button',{name:'Connect Gmail',exact:true})).toHaveCount(0);await snapshot(page,testInfo,'native-browser-connections-desktop.png');await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await snapshot(page,testInfo,'native-browser-connections-mobile.png');
});
