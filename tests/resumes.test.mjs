import '../server/runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright';
import {spawnSync} from 'node:child_process';
import {zipSync, unzipSync, strToU8, strFromU8} from 'fflate';
import {Store} from '../server/store.mjs';
import {ModelService} from '../server/model.mjs';
import {ResumeService, validateEdits, patchDocx, extract, renderText, hash, normalize} from '../server/resumes.mjs';

const sensorLine = '- Built a simulated sensor prototype in Python to evaluate signal quality.';
const measuredLine = '- Measured signal noise across 12 controlled simulation cases.';
const projectResume = (project, line, extra = '') => `# Alex Example\n\n## Projects\n### ${project}\n${line}\n${extra}\n## Skills\nPython and signal processing`;
const job = () => ({id:'synthetic-job',title:'Sensor engineering intern',employer:'Example Labs',revision:0,
  posting:{text:'Sensor engineering internship. Python experience is preferred. Build prototypes and evaluate signal quality.',requirements:['Python experience is preferred.'],sourceHash:'synthetic-posting'},
  reasoningAnswers:{'Available start date':'June'}});
const profile = {id:'main',fullName:'Alex Example',email:'alex@example.invalid',answers:{}};

async function fixture(t, runner = async () => { throw new Error('Unexpected reasoning request'); }) {
  const directory = await mkdtemp(path.join(tmpdir(),'hub-resume-test-'));
  const store = new Store(directory);
  store.put('profile',profile);
  store.put('connection',{id:'model',enabled:true,verified:true,fixture:true});
  const model = new ModelService({store,directory,runner});
  const service = new ResumeService({store,directory,model});
  t.after(async () => {store.close();await rm(directory,{recursive:true,force:true});});
  return {directory,store,service,model};
}

// Composition tests use synthetic, explicitly supplied source documents. The
// separate import/extract tests below exercise the actual document parsers.
async function addSource(ctx, id, text, {mega=false,mime='text/markdown',bytes=null} = {}) {
  const directory = path.join(ctx.directory,'synthetic-sources');
  await mkdir(directory,{recursive:true});
  const originalPath = path.join(directory,id+(mime==='application/pdf'?'.pdf':'.md'));
  const content = bytes || Buffer.from(text);
  await writeFile(originalPath,content,{mode:0o600});
  const doc = ctx.store.put('resume',{id,name:id+(mime==='application/pdf'?'.pdf':'.md'),text,mime,mega,
    originalPath,hash:hash(content),pages:1,renderStatus:'ready'});
  ctx.service.indexFacts(doc);
  return doc;
}

const response = (resumeId, edits=[]) => ({chosenResumeId:resumeId,explanation:'Synthetic controlled selection of supplied source evidence.',
  edits,requirements:[],questions:[]});
function factFor(ctx, text) {
  const found = ctx.store.list('fact').find(f=>f.text===text);
  assert(found,`Expected indexed source passage: ${text}`);
  return found;
}
async function linkedPdf(directory) {
  const output = path.join(directory,'linked-source.pdf');
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    await page.route('**/*',r=>r.abort());
    await page.setContent('<html><body><h1>Alex Example</h1><h2>Sensor prototype</h2><p>Built a simulated sensor prototype in Python to evaluate signal quality.</p><a href="https://example.invalid/sensor?version=1">Sensor project source</a></body></html>');
    await page.pdf({path:output,format:'Letter',tagged:true});
  } finally {await browser.close();}
  return {file:output,bytes:await readFile(output)};
}

test('selects a finished source unchanged, carries the actual posting and preserves PDF bytes and links',async t=>{
  let observed;
  const ctx = await fixture(t,async input=>{
    observed=input;
    const selected=input.resumes.find(r=>r.name==='Sensor finished.pdf');
    return response(selected.id);
  });
  const pdf = await linkedPdf(ctx.directory);
  const imported=await ctx.service.import([{name:'Sensor finished.pdf',content:pdf.bytes.toString('base64')}]);
  assert.equal(imported.imported,1,JSON.stringify(imported));
  await addSource(ctx,'software-finished',projectResume('Web prototype','- Built an unrelated JavaScript prototype for test fixtures.'));
  await addSource(ctx,'mega-evidence',projectResume('Sensor prototype',sensorLine,measuredLine),{mega:true});
  const pkg=await ctx.service.prepare(job(),profile);
  assert.equal(observed.job.description,job().posting.text);
  assert.deepEqual(observed.scopedAnswers,job().reasoningAnswers);
  assert.equal(observed.resumes.length,2);
  assert(!observed.resumes.some(r=>r.id==='mega-evidence'));
  assert(observed.facts.some(f=>f.sources.some(s=>s.resumeId==='mega-evidence')));
  assert.equal(pkg.changes.length,0);
  assert.deepEqual(await readFile(pkg.finalPath),pdf.bytes);
  const actual=await extract(pkg.finalPath,'application/pdf');
  assert.equal(actual.pages,1);
  assert.match(actual.text,/simulated sensor prototype/);
  assert.deepEqual(actual.links,['https://example.invalid/sensor?version=1']);
  assert.deepEqual(pkg.verification.links,actual.links);
  assert.equal(pkg.hash,hash(pdf.bytes));
});

test('the mega resume cannot become the uploaded base even if reasoning selects it',async t=>{
  const ctx=await fixture(t,async()=>response('mega-evidence'));
  await addSource(ctx,'finished',projectResume('Sensor prototype',sensorLine));
  await addSource(ctx,'mega-evidence',projectResume('Sensor prototype',sensorLine,measuredLine),{mega:true});
  await assert.rejects(ctx.service.prepare(job(),profile),/outside your finished resume library/);
  await assert.rejects(ctx.service.select(job(),'mega-evidence'),/mega resume is evidence only/);
  assert.equal(ctx.store.list('package').length,0);
});

test('borrows a mega-only passage within the same project, retains provenance and renders the real composed PDF',async t=>{
  let ctx;
  ctx=await fixture(t,async()=>response('finished',[{original:sensorLine,replacement:measuredLine,factIds:[factFor(ctx,measuredLine).id]}]));
  await addSource(ctx,'finished',projectResume('Sensor prototype',sensorLine));
  await addSource(ctx,'mega-evidence',projectResume('Sensor prototype',measuredLine),{mega:true});
  const pkg=await ctx.service.prepare(job(),profile);
  assert.equal(pkg.resumeId,'finished');
  assert(pkg.text.includes(measuredLine));
  assert(!pkg.text.includes(sensorLine));
  const source=factFor(ctx,measuredLine);
  assert.deepEqual(source.sources.map(s=>s.resumeId),['mega-evidence']);
  assert(pkg.sources.some(s=>s.factId===source.id));
  const rendered=await extract(pkg.previewPath,'application/pdf');
  assert.equal(rendered.pages,1);
  assert.match(rendered.text,/12 controlled simulation cases/);
  assert.equal(pkg.verification.pages,rendered.pages);
  assert.equal(pkg.verified,true);
  assert.equal(pkg.approved,false);
});

test('cannot create a false composite by moving a true claim to another named project',async t=>{
  const ctx=await fixture(t);
  const target=await addSource(ctx,'sensor-source',projectResume('Sensor prototype',sensorLine));
  await addSource(ctx,'robot-source',projectResume('Robot prototype',measuredLine),{mega:true});
  const source=factFor(ctx,measuredLine);
  assert.throws(()=>validateEdits(target,ctx.store.list('fact'),[{original:sensorLine,replacement:measuredLine,factIds:[source.id]}]),/different project or experience/);
});

test('a generic Projects section does not establish shared ownership for plain project titles',async t=>{
  const ctx=await fixture(t);
  const first='# Alex Example\n\n# Projects\nProject A\n'+sensorLine;
  const second='# Alex Example\n\n# Projects\nProject B\n'+measuredLine;
  const target=await addSource(ctx,'plain-project-a',first);
  await addSource(ctx,'plain-project-b',second,{mega:true});
  const source=factFor(ctx,measuredLine);
  assert.throws(()=>validateEdits(target,ctx.store.list('fact'),[{original:sensorLine,replacement:measuredLine,factIds:[source.id]}]),/different project or experience/);
});

test('unsupported numbers and removing simulation qualifiers fail factual grounding',async t=>{
  const ctx=await fixture(t);
  const target=await addSource(ctx,'finished',projectResume('Sensor prototype',sensorLine));
  const source=factFor(ctx,sensorLine);
  for(const replacement of [sensorLine.replace('simulated ','').replace('prototype','production deployment'),sensorLine+' Improved reliability by 95%.']) {
    assert.throws(()=>validateEdits(target,ctx.store.list('fact'),[{original:sensorLine,replacement,factIds:[source.id]}]),/no exact supporting source passage/);
  }
  assert.throws(()=>validateEdits(target,ctx.store.list('fact'),[{original:'simulated sensor prototype',replacement:sensorLine,factIds:[source.id]}]),/complete source line|different project or experience/);
});

test('repeated claims become one evidence record with distinct source provenance, not extra corroboration',async t=>{
  const ctx=await fixture(t);
  await addSource(ctx,'finished-one',projectResume('Sensor prototype',sensorLine));
  await addSource(ctx,'finished-two',projectResume('Sensor prototype',sensorLine,'- Wrote an additional documented fixture for local testing.'));
  const matching=ctx.store.list('fact').filter(f=>f.text===sensorLine);
  assert.equal(matching.length,1);
  assert.deepEqual(matching[0].sources.map(s=>s.resumeId).sort(),['finished-one','finished-two']);
  ctx.service.indexFacts(ctx.store.get('resume','finished-one'));
  assert.equal(factFor(ctx,sensorLine).sources.length,2);
});

test('contradictory metrics have no mega precedence and cannot pass through an unchanged selected resume',async t=>{
  const ctx=await fixture(t);
  const twelve='- Evaluated 12 controlled simulation cases.';
  const twenty='- Evaluated 20 controlled simulation cases.';
  await addSource(ctx,'finished-twelve',projectResume('Sensor prototype',twelve));
  await addSource(ctx,'mega-twenty',projectResume('Sensor prototype',twenty),{mega:true});
  const a=factFor(ctx,twelve),b=factFor(ctx,twenty);
  assert(a.conflict&&b.conflict);
  const decision=ctx.store.list('decision').find(d=>d.type==='fact_conflict');
  assert(decision&&decision.state==='open');
  assert.deepEqual(new Set(decision.factIds),new Set([a.id,b.id]));
  await assert.rejects(ctx.service.select(job(),'finished-twelve'),e=>e.code==='fact_conflict');
  assert.equal(ctx.store.list('package').length,0);
});

test('a candidate-rejected metric is blocked even when its finished resume is reused unchanged',async t=>{
  const ctx=await fixture(t);
  const twelve='- Evaluated 12 controlled simulation cases.';
  const twenty='- Evaluated 20 controlled simulation cases.';
  await addSource(ctx,'finished-twelve',projectResume('Sensor prototype',twelve));
  await addSource(ctx,'finished-twenty',projectResume('Sensor prototype',twenty));
  const a=factFor(ctx,twelve),b=factFor(ctx,twenty);
  ctx.store.put('fact',{...a,conflict:false,suppressed:false,confirmedAt:'2026-11-14T12:00:00Z'});
  ctx.store.put('fact',{...b,conflict:false,suppressed:true,confirmedAt:'2026-11-14T12:00:00Z'});
  await assert.rejects(ctx.service.select(job(),'finished-twenty'),e=>e.code==='fact_conflict');
  const pkg=await ctx.service.select(job(),'finished-twelve');
  assert(pkg.text.includes(twelve));
  assert(!pkg.text.includes(twenty));
});

test('later unrelated indexing preserves a candidate-confirmed correction',async t=>{
  const ctx=await fixture(t);
  const twelve='- Evaluated 12 controlled simulation cases.';
  const twenty='- Evaluated 20 controlled simulation cases.';
  await addSource(ctx,'finished-twelve',projectResume('Sensor prototype',twelve));
  await addSource(ctx,'finished-twenty',projectResume('Sensor prototype',twenty));
  const a=factFor(ctx,twelve),b=factFor(ctx,twenty),at='2026-11-14T12:00:00Z';
  ctx.store.put('fact',{...a,conflict:false,suppressed:false,confirmedAt:at});
  ctx.store.put('fact',{...b,conflict:false,suppressed:true,confirmedAt:at});
  const decision=ctx.store.list('decision').find(d=>d.type==='fact_conflict');
  ctx.store.put('decision',{...decision,state:'resolved',answer:twelve,resolvedAt:at});
  await addSource(ctx,'unrelated',projectResume('Web prototype','- Built an unrelated JavaScript prototype for local testing.'));
  assert.equal(ctx.store.get('fact',a.id).conflict,false,'Unrelated imports must not revoke the chosen fact');
  assert.equal(ctx.store.get('fact',b.id).suppressed,true,'Rejected fact must remain rejected');
  assert.equal(ctx.store.get('decision',decision.id).state,'resolved','Resolved correction must remain resolved');
});

test('requirement assessments need an exact quote from the actual posting',async t=>{
  const ctx=await fixture(t,async()=>({...response('finished'),requirements:[{text:'US citizenship',kind:'mandatory',assessment:'missing',quote:'US citizens only'}]}));
  await addSource(ctx,'finished',projectResume('Sensor prototype',sensorLine));
  await assert.rejects(ctx.service.prepare(job(),profile),/no matching posting quote/);
  assert.equal(ctx.store.list('package').length,0);
});

test('rendered Markdown preserves real source link targets and leaves executable links inert',async t=>{
  const ctx=await fixture(t),output=path.join(ctx.directory,'source-links.pdf');
  const target='https://example.invalid/sensor?version=1&view=source';
  await renderText('# Alex Example\n\n## Projects\n[Sensor project source]('+target+')\n[Unsafe link](javascript:alert(1))',output);
  const actual=await extract(output,'application/pdf');
  assert(actual.links.includes(target),'The rendered PDF must contain the original hyperlink target');
  assert(!actual.links.some(link=>/^javascript:/i.test(link)));
  assert.match(actual.text,/Sensor project source/);
});

test('a rendered document that expands beyond the permitted source page count is rejected',async t=>{
  const ctx=await fixture(t);
  const long=projectResume('Sensor prototype',sensorLine,Array(180).fill('- Documented a controlled prototype simulation and reviewed its observed signal quality.').join('\n'));
  await addSource(ctx,'overlong-finished',long);
  await assert.rejects(ctx.service.select(job(),'overlong-finished'),/exceeds the original page count/);
  assert.equal(ctx.store.list('package').length,0);
});

function docxFixture() {
  const document='<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>Alex Example</w:t></w:r></w:p><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Sensor </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>prototype</w:t></w:r></w:p><w:p><w:hyperlink r:id="rLink"><w:r><w:t>Project source</w:t></w:r></w:hyperlink></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>';
  const relationships='<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/sensor" TargetMode="External"/></Relationships>';
  const contentTypes='<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
  const rootRels='<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const files={'[Content_Types].xml':strToU8(contentTypes),'_rels/.rels':strToU8(rootRels),'word/document.xml':strToU8(document),'word/_rels/document.xml.rels':strToU8(relationships),'word/styles.xml':strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"/></w:styles>')};
  return {files,bytes:Buffer.from(zipSync(files))};
}

test('DOCX prose replacement supports split runs while preserving layout and untouched hyperlink relationships',async t=>{
  const ctx=await fixture(t),original=docxFixture();
  const replacement='Sensor prototype & simulation <validated>';
  const patched=patchDocx(original.bytes,[{original:'Sensor prototype',replacement}]);
  const files=unzipSync(patched),xml=strFromU8(files['word/document.xml']);
  for(const filename of ['[Content_Types].xml','_rels/.rels','word/_rels/document.xml.rels','word/styles.xml'])assert.deepEqual(files[filename],original.files[filename]);
  assert(xml.includes('<w:sectPr>'));
  assert(xml.includes('<w:pgSz w:w="12240" w:h="15840"/>'));
  assert(xml.includes('<w:hyperlink r:id="rLink">'));
  assert(xml.includes('&amp; simulation &lt;validated&gt;'));
  const file=path.join(ctx.directory,'patched.docx');await writeFile(file,patched);
  const extracted=await extract(file,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert(normalize(extracted.text).includes(replacement));
  assert(extracted.text.includes('Project source'));
  assert.deepEqual(extracted.links,['https://example.invalid/sensor']);
  assert.throws(()=>patchDocx(original.bytes,[{original:'Not present',replacement:'Invented'}]),/source paragraph was not unique/);
});

test('actual LibreOffice renders the supported DOCX fixture without losing source text or its hyperlink',async t=>{
  const renderer=spawnSync(process.env.HUB_SOFFICE_BIN||'soffice',['--version'],{encoding:'utf8',timeout:10000});
  if(renderer.error||renderer.status!==0){t.skip('LibreOffice is unavailable; DOCX preview requires its supported renderer.');return;}
  const ctx=await fixture(t),original=docxFixture();
  const imported=await ctx.service.import([{name:'Synthetic finished.docx',content:original.bytes.toString('base64')}]);
  assert.equal(imported.imported,1,JSON.stringify(imported));
  const source=ctx.store.list('resume')[0];
  assert.equal(source.renderStatus,'ready',source.renderError);
  assert.deepEqual(source.links,['https://example.invalid/sensor']);
  const pkg=await ctx.service.select(job(),source.id);
  assert.equal(pkg.mime,'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.deepEqual(await readFile(pkg.finalPath),original.bytes);
  const rendered=await extract(pkg.previewPath,'application/pdf');
  assert.equal(rendered.pages,1);
  assert(normalize(rendered.text).includes('Sensor prototype'));
  assert(rendered.links.includes('https://example.invalid/sensor'));
  assert.equal(pkg.verified,true);
});

test('a DOCX resume supplies its verified rendered PDF to all PDF-only resume controls and preserves editable originals',async t=>{
  const renderer=spawnSync(process.env.HUB_SOFFICE_BIN||'soffice',['--version'],{encoding:'utf8',timeout:10000});
  if(renderer.error||renderer.status!==0){t.skip('LibreOffice is unavailable; DOCX conversion requires its supported renderer.');return;}
  const ctx=await fixture(t),original=docxFixture();
  const imported=await ctx.service.import([{name:'Synthetic finished.docx',content:original.bytes.toString('base64')}]);
  assert.equal(imported.imported,1,JSON.stringify(imported));
  const source=ctx.store.list('resume')[0],selected=job();
  selected.posting.documents=[
    {label:'Resume',name:'resume',accept:'.pdf',required:true},
    {label:'Curriculum vitae',name:'cv',accept:'application/pdf',required:true},
    {label:'Cover letter',name:'cover_letter',accept:'.docx',required:false}
  ];
  const pkg=await ctx.service.select(selected,source.id);
  const upload=await readFile(pkg.finalPath);
  assert.equal(pkg.mime,'application/pdf');
  assert.equal(pkg.finalPath,pkg.previewPath);
  assert.equal(upload.subarray(0,5).toString(),'%PDF-');
  assert.equal(pkg.hash,hash(upload),'The dispatch identity must describe the actual PDF upload');
  assert(pkg.editableFinalPath&&pkg.editableFinalPath!==pkg.finalPath);
  assert.deepEqual(await readFile(pkg.editableFinalPath),original.bytes);
  assert.deepEqual(await readFile(source.originalPath),original.bytes);
  assert.equal(source.hash,hash(original.bytes));
  const rendered=await extract(pkg.finalPath,'application/pdf');
  assert.equal(rendered.pages,1);
  assert.match(rendered.text,/Alex Example/);
  assert(normalize(rendered.text).includes('Sensor prototype'));
  assert.deepEqual(rendered.links,['https://example.invalid/sensor']);
  assert.deepEqual(pkg.verification.links,rendered.links);
  assert.equal(pkg.verified,true);
  assert.equal(pkg.changes.length,0);
});

test('incompatible resume upload controls hold rather than publish a package accepted by only one control',async t=>{
  const renderer=spawnSync(process.env.HUB_SOFFICE_BIN||'soffice',['--version'],{encoding:'utf8',timeout:10000});
  if(renderer.error||renderer.status!==0){t.skip('LibreOffice is unavailable; DOCX conversion requires its supported renderer.');return;}
  const ctx=await fixture(t),original=docxFixture();
  const imported=await ctx.service.import([{name:'Synthetic finished.docx',content:original.bytes.toString('base64')}]);
  assert.equal(imported.imported,1,JSON.stringify(imported));
  const source=ctx.store.list('resume')[0];
  for(const controls of [
    [{label:'Resume',accept:'.pdf'},{label:'Curriculum vitae',accept:'.docx'}],
    [{label:'Resume',accept:'.rtf'}]
  ]){
    const selected=job();selected.posting.documents=controls;
    await assert.rejects(ctx.service.select(selected,source.id),error=>error.code==='resume_review'&&/common document format/.test(error.message));
    assert.equal(ctx.store.list('package').length,0,'No verified package may escape the format hold');
    assert(!ctx.store.list('event').some(event=>event.type==='package_prepared'));
    assert.deepEqual(await readFile(source.originalPath),original.bytes);
  }
});

test('malformed documents and oversized extracted text fail as scoped document errors',async t=>{
  const ctx=await fixture(t);
  const invalid=path.join(ctx.directory,'invalid.pdf');await writeFile(invalid,'%PDF-1.4\nnot a valid document');
  await assert.rejects(extract(invalid,'application/pdf'),e=>e.code==='document_invalid');
  const huge=path.join(ctx.directory,'huge.txt');await writeFile(huge,'a'.repeat(200001));
  await assert.rejects(extract(huge,'text/plain'),e=>e.code==='document_invalid'&&/200,000/.test(e.message));
});
