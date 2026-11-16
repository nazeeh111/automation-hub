import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {existsSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {Store} from '../server/store.mjs';import {ResumeService,hash,extract} from '../server/resumes.mjs';import {assertRenderedText} from '../server/render-integrity.mjs';
const renderer=process.env.HUB_SOFFICE_BIN||'/Applications/LibreOffice.app/Contents/MacOS/soffice';
if(!process.env.HUB_SOFFICE_BIN&&existsSync(renderer))process.env.HUB_SOFFICE_BIN=renderer;
const quote='I did not manage the autonomous controller deployment; I contributed only interface testing for this academic simulation.';
function docx({hidden=false,word='not',before='I did ',after='manage the autonomous controller deployment; I contributed only interface testing for this academic simulation.'}={}){
 const paragraph=text=>'<w:p><w:r><w:t>'+text+'</w:t></w:r></w:p>',heading=(text,level)=>'<w:p><w:pPr><w:pStyle w:val="Heading'+level+'"/></w:pPr><w:r><w:t>'+text+'</w:t></w:r></w:p>';
 const text='<w:p><w:pPr><w:pStyle w:val="ListParagraph"/></w:pPr><w:r><w:t xml:space="preserve">'+before+'</w:t></w:r><w:r>'+(hidden?'<w:rPr><w:vanish/></w:rPr>':'')+'<w:t xml:space="preserve">'+word+' </w:t></w:r><w:r><w:t>'+after+'</w:t></w:r></w:p>';
 const xml='<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+paragraph('Alex Example')+heading('Projects',1)+heading('Sensor prototype',2)+text+'<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>';
 return Buffer.from(zipSync({'[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),'_rels/.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),'word/document.xml':strToU8(xml),'word/styles.xml':strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="Heading 2"/></w:style></w:styles>'),'word/_rels/document.xml.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')}));
}
async function fixture(t){const directory=await mkdtemp(path.join(tmpdir(),'resume-integrity-')),store=new Store(directory);store.put('profile',{id:'main',fullName:'Alex Example',email:'alex@example.invalid'});let calls=0;const service=new ResumeService({store,directory,model:{reason:async()=>{calls++;throw new Error('Captured local comparison; no provider');}}});t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});return {store,directory,service,calls:()=>calls};}
const job={id:'synthetic-job',title:'Simulation engineering intern',employer:'Synthetic Employer',posting:{text:'Prototype interface testing internship.',documents:[]}};
async function add(ctx,bytes,name='Source.docx',mega=false){const result=await ctx.service.import([{name,content:bytes.toString('base64'),mega}]);assert.equal(result.imported,1,JSON.stringify(result));return ctx.store.get('resume','resume-'+hash(bytes).slice(0,24));}

test('whole-content comparison accepts only deterministic wraps, bullets and Unicode presentation differences',()=>{
 for(const [expected,actual,sourceMime] of [
 ['Worked on a candidate-authored prototype.','Worked on a candidate-\nauthored prototype.','text/plain'],
 ['Worked on a candidate-authored prototype.','Worked on a candidate-\n\nauthored prototype.','text/plain'],
 ['Tested Python interfaces in an academic simulation.','Tested Python interfaces\nin an academic\n simulation.','text/plain'],
 ['# Alex Example\n## Projects\n- Built a prototype.','Alex Example\nProjects\nBuilt a prototype.','text/markdown'],
 ['Alex Example\nBuilt a prototype.','Alex Example\n• Built a prototype.','application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
 ['Used ﬁnite ＡＢＣ methods and “prototype” tests.','Used finite ABC methods and "prototype" tests.','text/plain'],
 ['Built a non-breaking prototype.','Built a non‑breaking prototype.','text/plain']
 ,['Built a non-breaking prototype.','Built a non ‑ breaking prototype.','text/plain']
 ])assert.deepEqual(assertRenderedText(expected,actual,{sourceMime}),{text:true});
});
for(const [name,expected,actual] of [
 ['negation','I did not manage the deployment.','I did manage the deployment.'],
 ['ownership','I only assisted the team.','I led the team.'],
 ['date','Internship May 2025 through August 2025.','Internship May 2024 through August 2025.'],
 ['metric','Tested 12 controlled cases.','Tested 120 controlled cases.'],
 ['qualifier','Built a simulated academic prototype.','Built an academic prototype.'],
 ['short skill','Skills C++ and C#.','Skills C and C#.'],
 ['negative value','-3 units of measured drift.','3 units of measured drift.'],
 ['added claim','Built a prototype.','Built a prototype. Managed the department.'],
 ['changed order','Assisted Alex; led by Sam.','Assisted Sam; led by Alex.'],
 ['duplicate loss','Assisted a team. Assisted a team.','Assisted a team.'],
 ['hard hyphen loss','Re-sign contracts.','Resign contracts.']
])test('full render agreement rejects factual '+name,()=>assert.throws(()=>assertRenderedText(expected,actual,{sourceMime:'text/plain'}),error=>error.renderCode==='render_integrity_review'));

test('actual visible DOCX keeps its template bytes, qualifier and verified unchanged package',async t=>{
 const ctx=await fixture(t),bytes=docx(),resume=await add(ctx,bytes);
 assert.equal(resume.renderStatus,'ready');assert.deepEqual(await readFile(resume.originalPath),bytes);
 const pkg=await ctx.service.select(job,resume.id);assert.equal(pkg.verified,true);assert.equal(pkg.verification.text,true);assert.deepEqual(await readFile(pkg.finalPath),bytes);
});
test('actual hidden negation remains recoverable with a review status and cannot become a package or spend a comparison call',async t=>{
 const ctx=await fixture(t),bytes=docx({hidden:true}),resume=await add(ctx,bytes);
 assert.equal(resume.renderStatus,'needs_review');assert.equal(resume.renderCode,'render_integrity_review');assert(resume.previewPath);assert((await readFile(resume.previewPath)).subarray(0,5).equals(Buffer.from('%PDF-')));
 assert.deepEqual(await readFile(resume.originalPath),bytes);assert(resume.text.includes(quote));assert(ctx.store.list('fact').some(fact=>fact.text===quote));
 await assert.rejects(ctx.service.select(job,resume.id),/rendered-text mismatch/);
 await assert.rejects(ctx.service.prepare(job,ctx.store.get('profile','main')),/rendered-text review/);
 assert.equal(ctx.calls(),0);assert.equal(ctx.store.list('package').length,0);
});
test('actual legacy ready record still cannot bypass the final full-text package gate',async t=>{
 const ctx=await fixture(t),resume=await add(ctx,docx({hidden:true}));
 const legacy=ctx.store.put('resume',{...resume,renderStatus:'ready',renderCode:undefined,renderError:undefined});
 await assert.rejects(ctx.service.select(job,legacy.id),error=>error.renderCode==='render_integrity_review');assert.equal(ctx.store.list('package').length,0);
});
test('actual hidden ownership qualifier is held without relying on a keyword blacklist',async t=>{
 const ctx=await fixture(t),resume=await add(ctx,docx({hidden:true,before:'I ',word:'independently',after:'tested the interface during the academic project.'}));
 assert.equal(resume.renderStatus,'needs_review');await assert.rejects(ctx.service.select(job,resume.id),/rendered-text mismatch/);
});
for(const [name,before,word,after] of [['date','Completed the academic project in ','2025','with controlled prototype tests.'],['qualifier','Built a ','simulated','academic prototype for controlled interface tests.']])test('actual hidden '+name+' cannot be marked verified',async t=>{
 const ctx=await fixture(t),resume=await add(ctx,docx({hidden:true,before,word,after}));assert.equal(resume.renderStatus,'needs_review');assert(resume.previewPath);await assert.rejects(ctx.service.select(job,resume.id),/rendered-text mismatch/);assert.equal(ctx.store.list('package').length,0);
});
test('actual DOCX preserves ordinary Unicode, hyphens and physical line wraps',async t=>{
 const ctx=await fixture(t),bytes=docx({before:'I tested ',word:'candidate-authored',after:'non‑breaking prototypes with ﬁnite interface methods during an academic simulation. The controlled interface included ordinary Unicode and enough words to wrap across physical PDF lines.'}),resume=await add(ctx,bytes);assert.equal(resume.renderStatus,'ready',JSON.stringify({source:resume.text,preview:(await extract(resume.previewPath,'application/pdf')).text}));const pkg=await ctx.service.select(job,resume.id);assert.equal(pkg.verified,true);assert.deepEqual(await readFile(pkg.finalPath),bytes);
});
test('held-source-only facts are excluded from comparison and borrowing, while independently verified corroboration remains usable',async t=>{
 const ctx=await fixture(t),held=await add(ctx,docx({hidden:true}),'Held.docx',true);
 const original='- Assisted with interface tests for an academic simulation.',base=await add(ctx,Buffer.from('# Alex Example\n\n## Projects\n### Sensor prototype\n'+original+'\n'),'Base.md');
 const fact=ctx.store.list('fact').find(item=>item.text===quote);assert(fact);
 await assert.rejects(ctx.service.createPackage(job,base,{explanation:'Synthetic borrow',edits:[{original,replacement:quote,factIds:[fact.id]}]}),/no exact supporting source/);
 let observed;ctx.service.model.reason=async input=>{observed=input;throw new Error('Captured local comparison; no provider');};
 await assert.rejects(ctx.service.prepare(job,ctx.store.get('profile','main')),/Captured local comparison/);
 assert(!observed.facts.some(item=>item.id===fact.id));assert(!observed.resumes.some(item=>item.id===held.id));
 const corroboration=await add(ctx,docx(),'Corroborated.docx',true);assert.equal(corroboration.renderStatus,'ready');
 const pkg=await ctx.service.createPackage(job,base,{explanation:'Verified corroboration',edits:[{original,replacement:quote,factIds:[fact.id]}]});assert.equal(pkg.verified,true);
 const refreshed=ctx.store.get('resume',corroboration.id);ctx.store.put('resume',{...refreshed,renderStatus:'needs_review',renderCode:'render_integrity_review'});
 assert.throws(()=>ctx.service.assertPackageCurrent(pkg),/no current usable document source/);
});

