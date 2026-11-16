import {postingJob} from './fixtures/posting.mjs';
import '../server/runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {Store} from '../server/store.mjs';
import {ResumeService,extract,hash,validateEdits,resumePassageContext,passageContext} from '../server/resumes.mjs';
import {resumeStructureCatalog,resumeStructureContexts,restructureResume,readOriginalResume} from '../server/resume-structure.mjs';

const markdown='# Alex Example\n\n## Projects\n### Web prototype\nTeam project | 2025\n- Assisted a team with a simulated JavaScript prototype.\n- Tested 8 controlled web cases.\n\n### Sensor prototype\nAcademic project | 2026\n- Built a simulated sensor prototype in Python.\n- Measured signal noise across 12 controlled simulation cases.\n\n## Skills\nPython, JavaScript and signal processing\n';
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const esc=value=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function docxFixture(){
 const p=(text,style='',bullet=false)=>`<w:p><w:pPr>${style?`<w:pStyle w:val="${style}"/>`:''}${bullet?'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>':''}<w:spacing w:after="80"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>${esc(text)}</w:t></w:r></w:p>`;
 const link=(id,title)=>`<w:p><w:hyperlink r:id="${id}"><w:r><w:t>${title}</w:t></w:r></w:hyperlink></w:p>`;
 const header=p('Alex Example','Title'),web=[p('Web prototype','Heading2'),p('Team project | 2025'),p('Assisted a team with a simulated JavaScript prototype.','ListParagraph',true),link('web','Web project source')].join('');
 const sensor=[p('Sensor prototype','Heading2'),p('Academic project | 2026'),p('Built a simulated sensor prototype in Python.','ListParagraph',true),p('Measured signal noise across 12 controlled simulation cases.','ListParagraph',true),link('sensor','Sensor project source')].join('');
 const xml=`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${header}${p('Projects','Heading1')}${web}${sensor}${p('Skills','Heading1')}${p('Python, JavaScript and signal processing')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`;
 const styles='<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'+['Normal','Title','Heading1','Heading2','ListParagraph'].map(id=>`<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${id}"/></w:style>`).join('')+'</w:styles>';
 const numbering='<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>';
 const rels='<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="web" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/web" TargetMode="External"/><Relationship Id="sensor" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/sensor" TargetMode="External"/><Relationship Id="styles" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="num" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>';
 const types='<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>';
 const files={'[Content_Types].xml':strToU8(types),'_rels/.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),'word/document.xml':strToU8(xml),'word/styles.xml':strToU8(styles),'word/numbering.xml':strToU8(numbering),'word/_rels/document.xml.rels':strToU8(rels)};
 return {bytes:Buffer.from(zipSync(files)),files,header,web,sensor};
}
function selection(catalog,{omitWeb=false}={}){const section=catalog.sections[0],sensor=section.blocks.find(block=>block.title==='Sensor prototype'),web=section.blocks.find(block=>block.title==='Web prototype');return [{sectionId:section.id,blocks:[{id:sensor.id,bulletIds:[...sensor.bulletIds].reverse()},...(!omitWeb?[{id:web.id,bulletIds:[web.bulletIds[0]]}]:[])]}];}
test('project and bullet selection retains exact contribution, dates and qualification context',()=>{
 const bytes=Buffer.from(markdown),source={id:'source',mime:'text/markdown',hash:hash(bytes),text:markdown},catalog=resumeStructureCatalog(source,bytes),result=restructureResume(source,bytes,selection(catalog));
 assert(result.text.indexOf('### Sensor prototype')<result.text.indexOf('### Web prototype'));
 assert(result.text.indexOf('12 controlled simulation cases')<result.text.indexOf('Built a simulated sensor'));
 assert.match(result.text,/Academic project \| 2026/);assert.match(result.text,/Team project \| 2025/);assert.match(result.text,/Assisted a team with a simulated/);assert(!result.text.includes('8 controlled web cases'));
 assert(result.text.startsWith('# Alex Example\n\n## Projects'));assert(result.text.endsWith('## Skills\nPython, JavaScript and signal processing\n'));assert.equal(result.provenance[0].sourceHash,source.hash);assert.equal(result.changes.length,1);
});
test('structural changes reject invented IDs, cross-project bullets and unsupported layouts',()=>{
 const bytes=Buffer.from(markdown),source={id:'source',mime:'text/markdown',hash:hash(bytes),text:markdown},catalog=resumeStructureCatalog(source,bytes),operation=selection(catalog);
 const wrong=structuredClone(operation);wrong[0].blocks[0].bulletIds=[catalog.sections[0].blocks[0].bulletIds[0]];assert.throws(()=>restructureResume(source,bytes,wrong),/original project/);
 const invented=structuredClone(operation);invented[0].blocks[0].id='invented';assert.throws(()=>restructureResume(source,bytes,invented),/does not belong/);
 assert.throws(()=>restructureResume({...source,mime:'application/pdf'},bytes,operation),/PDF originals/);
 const docx=docxFixture();docx.files['word/document.xml']=strToU8(strFromU8(docx.files['word/document.xml']).replace('<w:body>','<w:body><w:tbl/>'));
 assert.equal(resumeStructureCatalog({id:'docx',mime,hash:'synthetic'},Buffer.from(zipSync(docx.files))).supported,false);
});
test('interleaved phase/date paragraphs stay attached to their bullets during intact project moves',()=>{
 const text='# Alex Example\n\n## Projects\n### Sensor prototype\nSimulation phase\n- Built a simulated sensor prototype.\n2025 field phase\n- Assisted a team with field observations.\n\n### Web prototype\n- Built an academic web prototype.\n\n## Skills\nPython\n',bytes=Buffer.from(text),source={id:'source',mime:'text/markdown',hash:hash(bytes),text},catalog=resumeStructureCatalog(source,bytes),section=catalog.sections[0],sensor=section.blocks[0],web=section.blocks[1];
 assert.equal(sensor.bulletSelectionSupported,false);
 const operation=[{sectionId:section.id,blocks:[{id:web.id,bulletIds:web.bulletIds},{id:sensor.id,bulletIds:sensor.bulletIds}]}],moved=restructureResume(source,bytes,operation);
 assert(moved.text.includes('Simulation phase\n- Built a simulated sensor prototype.\n2025 field phase\n- Assisted a team with field observations.'));
 const changed=structuredClone(operation);changed[0].blocks[1].bulletIds=[...sensor.bulletIds].reverse();assert.throws(()=>restructureResume(source,bytes,changed),/interleaves dates/);
 changed[0].blocks[1].bulletIds=[sensor.bulletIds[0]];assert.throws(()=>restructureResume(source,bytes,changed),/intact block/);
});
test('nested bullets cannot lose their qualifying parent in Markdown or DOCX',()=>{
 const text='# Alex Example\n## Projects\n### Sensor prototype\n- Simulation-only evaluation\n  - Measured 12 cases.\n## Skills\nPython\n',bytes=Buffer.from(text),source={id:'nested',mime:'text/markdown',hash:hash(bytes),text},catalog=resumeStructureCatalog(source,bytes),section=catalog.sections[0],block=section.blocks[0];assert.equal(block.bulletSelectionSupported,false);
 assert.throws(()=>restructureResume(source,bytes,[{sectionId:section.id,blocks:[{id:block.id,bulletIds:[block.bulletIds[1]]}]}]),/nested lists/);
 const retained=restructureResume(source,bytes,[{sectionId:section.id,blocks:[{id:block.id,bulletIds:block.bulletIds}]}]);assert.equal(retained.text,text);
 const f=docxFixture();f.files['word/document.xml']=strToU8(strFromU8(f.files['word/document.xml']).replace('w:ilvl w:val="0"','w:ilvl w:val="1"'));const native=Buffer.from(zipSync(f.files)),nativeCatalog=resumeStructureCatalog({id:'nested-docx',mime,hash:hash(native)},native);assert.equal(nativeCatalog.sections[0].blocks[0].bulletSelectionSupported,false);
 const ordered=docxFixture();ordered.files['word/numbering.xml']=strToU8(strFromU8(ordered.files['word/numbering.xml']).replace('w:numFmt w:val="bullet"','w:numFmt w:val="decimal"'));const numbered=Buffer.from(zipSync(ordered.files)),numberedCatalog=resumeStructureCatalog({id:'ordered-docx',mime,hash:hash(numbered)},numbered);assert(numberedCatalog.sections[0].blocks.every(item=>item.bulletSelectionSupported===false));
});
test('DOCX reordering preserves original paragraph XML, styles, numbering and relationship bytes',()=>{
 const f=docxFixture(),source={id:'docx',mime,hash:hash(f.bytes),text:''},catalog=resumeStructureCatalog(source,f.bytes),result=restructureResume(source,f.bytes,selection(catalog,{omitWeb:true})),files=unzipSync(result.bytes),xml=strFromU8(files['word/document.xml']);
 assert(xml.includes(f.header));assert(xml.includes(f.sensor.match(/<w:p>[\s\S]*?<\/w:p>/)[0]));assert(!xml.includes(f.web));
 for(const name of ['word/styles.xml','word/numbering.xml','word/_rels/document.xml.rels'])assert.deepEqual(files[name],f.files[name]);
 assert.deepEqual(result.links,['https://example.invalid/sensor']);assert.match(result.text,/Academic project \| 2026/);assert(!result.text.includes('2025'));
});
async function fixture(t){const directory=await mkdtemp(path.join(tmpdir(),'hub-structure-')),store=new Store(directory);store.put('profile',{id:'main',fullName:'Alex Example',email:'alex@example.invalid'});store.put('campaign',{...store.get('campaign','main'),rules:{autoApproveUnchanged:true}});t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});return {directory,store};}
test('a rendered unchanged package rejects later retained source conflicts and rejections without broad library invalidation',async t=>{
 const ctx=await fixture(t),service=new ResumeService(ctx);assert.equal((await service.import([{name:'Finished.md',content:Buffer.from(markdown).toString('base64')}])).imported,1);
 const source=ctx.store.list('resume')[0],originalBytes=await readFile(source.originalPath),pkg=await service.select(postingJob(ctx.store,{id:'current-package'}),source.id);
 assert.equal(service.assertPackageCurrent(pkg),pkg);assert.match((await extract(pkg.previewPath,'application/pdf')).text,/12 controlled simulation cases/);
 ctx.store.put('fact',{id:'unrelated-new-fact',text:'Measured 99 unrelated cases.',sources:[{resumeId:'unrelated-resume'}],conflict:true,suppressed:true});assert.equal(service.assertPackageCurrent(pkg),pkg,'A different source fact must not invalidate the prepared document');
 const retained=ctx.store.list('fact').find(fact=>fact.text.includes('Measured signal noise'));
 for(const state of [{conflict:true,suppressed:false},{conflict:false,suppressed:true}]){ctx.store.put('fact',{...retained,...state});assert.throws(()=>service.assertPackageCurrent(pkg),error=>error.code==='resume_review'&&/rejected|unresolved/.test(error.message));ctx.store.put('fact',retained);}
 assert.deepEqual(await readFile(source.originalPath),originalBytes);assert.equal(service.assertPackageCurrent(pkg),pkg);
});
test('prepared package validity follows retained passages rather than every fact in its base resume',async t=>{
 const ctx=await fixture(t),service=new ResumeService(ctx);assert.equal((await service.import([{name:'Finished.md',content:Buffer.from(markdown).toString('base64')}])).imported,1);
 const source=ctx.store.list('resume')[0],catalog=resumeStructureCatalog(source,Buffer.from(markdown)),pkg=await service.createPackage(postingJob(ctx.store,{id:'selected-package'}),source,{explanation:'Retain the sensor project only.',structureEdits:selection(catalog,{omitWeb:true})});
 assert(!pkg.text.includes('simulated JavaScript'));const omitted=ctx.store.list('fact').find(fact=>fact.text.includes('simulated JavaScript'));ctx.store.put('fact',{...omitted,conflict:true,suppressed:true});assert.equal(service.assertPackageCurrent(pkg),pkg);
});
test('borrowed retained evidence is checked after preparation even when it came only from a mega source',async t=>{
 const ctx=await fixture(t),service=new ResumeService(ctx),base='# Alex Example\n## Projects\n### Sensor prototype\nAcademic project | 2026\n- Built a simulated sensor prototype in Python.\n## Skills\nPython\n',mega=base.replace('Built a simulated sensor prototype in Python.','Measured signal noise across 12 controlled simulation cases.');
 assert.equal((await service.import([{name:'Finished.md',content:Buffer.from(base).toString('base64')},{name:'Mega.md',content:Buffer.from(mega).toString('base64'),mega:true}])).imported,2);
 const source=ctx.store.list('resume').find(item=>!item.mega),fact=ctx.store.list('fact').find(item=>item.text.includes('Measured signal noise')),pkg=await service.createPackage(postingJob(ctx.store,{id:'borrowed-package'}),source,{explanation:'Borrow exact simulation evidence.',edits:[{original:'- Built a simulated sensor prototype in Python.',replacement:fact.text,factIds:[fact.id]}]});
 assert.equal(service.assertPackageCurrent(pkg),pkg);assert(pkg.sources.some(item=>item.factId===fact.id&&item.quote===fact.text));assert.match((await extract(pkg.previewPath,'application/pdf')).text,/12 controlled simulation cases/);
 for(const state of [{suppressed:true},{conflict:true}]){ctx.store.put('fact',{...fact,...state});assert.throws(()=>service.assertPackageCurrent(pkg),error=>error.code==='resume_review');ctx.store.put('fact',fact);}
 ctx.store.put('fact',{...fact,text:fact.text.replace('12','99')});assert.throws(()=>service.assertPackageCurrent(pkg),error=>error.code==='resume_review');ctx.store.put('fact',fact);
 ctx.store.remove('fact',fact.id);assert.throws(()=>service.assertPackageCurrent(pkg),error=>error.code==='resume_review'&&/no longer available/.test(error.message));
});
test('prepared package captures full initial profile bytes and detects changes even without a new revision timestamp',async t=>{
 const ctx=await fixture(t),service=new ResumeService(ctx);ctx.store.put('profile',{...ctx.store.get('profile','main'),updatedAt:'2026-11-14T12:00:00Z',availability:{start:'2027-05-01'}});assert.equal((await service.import([{name:'Finished.md',content:Buffer.from(markdown).toString('base64')}])).imported,1);
 const profile=ctx.store.get('profile','main'),pkg=await service.select(postingJob(ctx.store,{id:'profile-package'}),ctx.store.list('resume')[0].id);assert.equal(pkg.profileHash,hash(JSON.stringify(profile)));assert.equal(service.assertPackageCurrent(pkg,profile),pkg);
 // Simulate same-millisecond persistence or restored bytes without letting Store.put create a fresh timestamp.
 const persistSnapshot=value=>ctx.store.db.prepare('UPDATE documents SET body=? WHERE kind=? AND id=?').run(JSON.stringify(value),'profile','main');
 const changed={...profile,availability:{start:'2027-06-01'}};persistSnapshot(changed);assert.equal(ctx.store.get('profile','main').updatedAt,pkg.profileRevision);assert.throws(()=>service.assertPackageCurrent(pkg),error=>error.code==='resume_review'&&/profile changed/.test(error.message));assert.throws(()=>service.assertPackageCurrent(pkg,changed),error=>error.code==='resume_review');
 persistSnapshot(profile);assert.equal(service.assertPackageCurrent(pkg),pkg);persistSnapshot({...profile,updatedAt:'2026-11-14T13:00:00Z'});assert.throws(()=>service.assertPackageCurrent(pkg),error=>error.code==='resume_review');
});
test('actual DOCX render verifies the reordered final, exact retained links and explicit review requirement',async t=>{
 const ctx=await fixture(t),f=docxFixture(),service=new ResumeService(ctx);const imported=await service.import([{name:'Finished.docx',content:f.bytes.toString('base64')}]);assert.equal(imported.imported,1,JSON.stringify(imported));const source=ctx.store.list('resume')[0],catalog=resumeStructureCatalog(source,f.bytes);
 const pkg=await service.createPackage(postingJob(ctx.store,{id:'job'}),source,{explanation:'Prioritize the original sensor evidence.',structureEdits:selection(catalog,{omitWeb:true})});
 assert.equal(pkg.verified,true);assert.equal(pkg.approved,false);assert.equal(pkg.structureProvenance[0].sourceHash,source.hash);assert.deepEqual(await readFile(source.originalPath),f.bytes);
 const rendered=await extract(pkg.previewPath,'application/pdf');assert.match(rendered.text,/12 controlled simulation cases/);assert.match(rendered.text,/simulated sensor prototype/);assert(!rendered.text.includes('Web prototype'));assert.deepEqual(rendered.links,['https://example.invalid/sensor']);assert.equal(pkg.hash,hash(await readFile(pkg.finalPath)));
});
test('resume preparation supplies source IDs to reasoning and renders its bounded structure operation',async t=>{
 const ctx=await fixture(t);let observed;const service=new ResumeService({...ctx,model:{async reason(input){observed=input;return {chosenResumeId:input.resumes[0].id,explanation:'Place the sensor project first while retaining its source.',edits:[],structureEdits:selection(input.structureCatalog[0]),requirements:[],questions:[]};}}});await service.import([{name:'Finished.md',content:Buffer.from(markdown).toString('base64')}]);
 const pkg=await service.prepare(postingJob(ctx.store,{id:'job',title:'Sensor engineering intern',posting:{text:'Sensor engineering using Python and signal processing.',sourceHash:'posting'}}),ctx.store.get('profile','main'));assert(observed.structureCatalog[0].supported);assert.equal(pkg.approved,false);const rendered=await extract(pkg.previewPath,'application/pdf');assert(rendered.text.indexOf('Sensor prototype')<rendered.text.indexOf('Web prototype'));assert.match(rendered.text,/simulated JavaScript prototype/);assert(!rendered.text.includes('8 controlled web cases'));
});
test('changed source bytes and symbolic source replacements cannot be reused under an imported fingerprint',async t=>{
 const ctx=await fixture(t),file=path.join(ctx.directory,'source.md');await writeFile(file,markdown);const source={id:'source',originalPath:file,mime:'text/markdown',hash:hash(Buffer.from(markdown)),text:markdown};assert.deepEqual(await readOriginalResume(source),Buffer.from(markdown));await writeFile(file,markdown.replace('12 controlled','99 controlled'));await assert.rejects(readOriginalResume(source),error=>error.code==='resume_review'&&/changed after import/.test(error.message));
 const link=path.join(ctx.directory,'source-link.md');await symlink(file,link);await assert.rejects(readOriginalResume({...source,originalPath:link}),error=>error.code==='resume_review');
});
test('a candidate change during real document preparation cannot relabel an older person’s document as current',async t=>{
 const ctx=await fixture(t),service=new ResumeService(ctx);await service.import([{name:'Finished.md',content:Buffer.from(markdown).toString('base64')}]);
 const pending=service.select(postingJob(ctx.store,{id:'job'}),ctx.store.list('resume')[0].id);ctx.store.put('profile',{...ctx.store.get('profile','main'),fullName:'Different Candidate'});
 await assert.rejects(pending,error=>error.code==='resume_review'&&/changed during document preparation/.test(error.message));assert.equal(ctx.store.list('package').length,0);assert(!ctx.store.list('event').some(event=>event.type==='package_prepared'));
});
test('reasoning results are revoked when their candidate or evidence library changes while waiting',async t=>{
 for(const mutation of ['profile','facts','library']){
  const ctx=await fixture(t);let entered,finish;const started=new Promise(resolve=>entered=resolve),service=new ResumeService({...ctx,model:{async reason(input){entered();return new Promise(resolve=>finish=()=>resolve({chosenResumeId:input.resumes[0].id,explanation:'Old snapshot.',edits:[],requirements:[],questions:[]}));}}});await service.import([{name:'Finished.md',content:Buffer.from(markdown).toString('base64')}]);
  const pending=service.prepare(postingJob(ctx.store,{id:'job',title:'Sensor engineering intern',posting:{text:'Python sensor work.',sourceHash:'posting'}}),ctx.store.get('profile','main'));await started;
  if(mutation==='profile')ctx.store.put('profile',{...ctx.store.get('profile','main'),location:'Candidate-supplied new location'});
  if(mutation==='facts'){const fact=ctx.store.list('fact')[0];ctx.store.put('fact',{...fact,suppressed:true});}
  if(mutation==='library')ctx.store.put('resume',{...ctx.store.list('resume')[0],id:'new-variant',name:'New supplied variant'});
  finish();await assert.rejects(pending,error=>error.code==='resume_review'&&/changed during comparison/.test(error.message),mutation);assert.equal(ctx.store.list('package').length,0);
 }
});

function contextualDocx(blocks){
 const base=docxFixture();
 const p=(text,style='',bullet=false)=>`<w:p><w:pPr>${style?`<w:pStyle w:val="${style}"/>`:''}${bullet?'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>':''}</w:pPr><w:r><w:rPr><w:sz w:val="20"/></w:rPr><w:t>${esc(text)}</w:t></w:r></w:p>`;
 const projectXml=blocks.map(block=>p(block.title,'Heading2')+block.items.map(item=>p(item.text,item.phase?'Heading3':'',item.bullet)).join('')).join('');
 const xml=`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${p('Alex Example','Title')}${p('Projects','Heading1')}${projectXml}${p('Skills','Heading1')}${p('Python and signal processing')}<w:p><w:hyperlink r:id="web"><w:r><w:t>Web project source</w:t></w:r></w:hyperlink></w:p><w:p><w:hyperlink r:id="sensor"><w:r><w:t>Sensor project source</w:t></w:r></w:hyperlink></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>`;
 base.files['word/document.xml']=strToU8(xml);base.files['word/styles.xml']=strToU8(strFromU8(base.files['word/styles.xml']).replace('</w:styles>','<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="Heading3"/></w:style></w:styles>'));
 return {...base,bytes:Buffer.from(zipSync(base.files)),projectXml};
}
const nativeOriginal='Built a simulated sensor prototype in Python.';
const nativeMetric='Measured signal noise across 12 controlled simulation cases.';
const metadata={text:'Academic project | 2026'};

test('actual titlecase DOCX project headings prevent same-year cross-project borrowing',async t=>{
 const ctx=await fixture(t),service=new ResumeService(ctx),f=contextualDocx([{title:'Sensor prototype',items:[metadata,{text:nativeOriginal,bullet:true}]},{title:'Web prototype',items:[metadata,{text:nativeMetric,bullet:true}]}]);
 assert.equal((await service.import([{name:'Native projects.docx',content:f.bytes.toString('base64')}])).imported,1);
 const resume=ctx.store.list('resume')[0],fact=ctx.store.list('fact').find(item=>item.text===nativeMetric);
 assert.equal(resume.structureContexts.sourceHash,resume.hash);
 const targetContext=resumePassageContext(resume,nativeOriginal),sourceContext=fact.sources[0].context;
 assert.match(targetContext,/^projects\|scope:[a-f0-9]+\|sensor prototype$/);assert.match(sourceContext,/\|web prototype$/);assert.notEqual(targetContext,sourceContext);
 assert.throws(()=>validateEdits(resume,ctx.store.list('fact'),[{original:nativeOriginal,replacement:nativeMetric,factIds:[fact.id]}]),/different project or experience/);
});

test('actual matching native DOCX templates still borrow same-project evidence and retain original layout/links',async t=>{
 const ctx=await fixture(t),service=new ResumeService(ctx),first=contextualDocx([{title:'Sensor prototype',items:[metadata,{text:nativeOriginal,bullet:true}]}]),second=contextualDocx([{title:'Sensor prototype',items:[metadata,{text:nativeMetric,bullet:true}]}]);
 const imported=await service.import([{name:'Finished native.docx',content:first.bytes.toString('base64')},{name:'Mega native.docx',content:second.bytes.toString('base64'),mega:true}]);assert.equal(imported.imported,2,JSON.stringify(imported));
 const resume=ctx.store.list('resume').find(item=>!item.mega),fact=ctx.store.list('fact').find(item=>item.text===nativeMetric);
 assert.equal(resumePassageContext(resume,nativeOriginal),fact.sources[0].context);
 const pkg=await service.createPackage(postingJob(ctx.store,{id:'job'}),resume,{explanation:'Use the same native project’s measured simulation evidence.',edits:[{original:nativeOriginal,replacement:nativeMetric,factIds:[fact.id]}]});
 const rendered=await extract(pkg.previewPath,'application/pdf');assert.match(rendered.text,/12 controlled simulation cases/);assert.match(rendered.text,/Academic project \| 2026/);assert.equal(pkg.verified,true);assert.equal(pkg.approved,false);
 assert.deepEqual(await readFile(resume.originalPath),first.bytes);
 const final=unzipSync(await readFile(pkg.finalPath));for(const file of ['word/styles.xml','word/numbering.xml','word/_rels/document.xml.rels'])assert.deepEqual(final[file],first.files[file]);
 assert.deepEqual(new Set(rendered.links),new Set(['https://example.invalid/web','https://example.invalid/sensor']));
});

test('native nested phase headings remain under the project and repeated phase/project passages are ambiguous',async t=>{
 const ctx=await fixture(t),service=new ResumeService(ctx),repeated='Documented the project results carefully.';
 const f=contextualDocx([{title:'Sensor prototype',items:[metadata,{text:'Simulation phase',phase:true},{text:'Evaluated 12 simulated cases.',bullet:true},{text:repeated,bullet:true},{text:'Field phase',phase:true},{text:'Evaluated 20 field cases.',bullet:true},{text:repeated,bullet:true}]},{title:'Robot prototype',items:[metadata,{text:repeated,bullet:true}]}]);
 assert.equal((await service.import([{name:'Native phases.docx',content:f.bytes.toString('base64')}])).imported,1);
 const resume=ctx.store.list('resume')[0],catalog=resumeStructureCatalog(resume,f.bytes);assert.equal(catalog.sections[0].blocks.length,2);assert.equal(catalog.sections[0].blocks[0].bulletSelectionSupported,false);
 const simulation=resumePassageContext(resume,'Evaluated 12 simulated cases.'),field=resumePassageContext(resume,'Evaluated 20 field cases.');assert.notEqual(simulation,field);assert(simulation.endsWith('|sensor prototype'));assert(field.endsWith('|sensor prototype'));
 assert(resume.structureContexts.scopeEvidence[simulation].includes('Simulation phase'));assert(resume.structureContexts.scopeEvidence[field].includes('Field phase'));assert(!resume.structureContexts.scopeEvidence[field].includes('Simulation phase'));
 assert.equal(resumePassageContext(resume,repeated),null,'A shared sentence must not select a project or phase by its first occurrence');
});

test('Markdown structured maps preserve ordinary matching projects and fail closed on stale hashes/text',()=>{
 const text='# Alex Example\n## Projects\n### Sensor prototype\n- Built a simulated sensor prototype.\n- Measured 12 simulation cases.\n## Skills\nPython\n',bytes=Buffer.from(text),resume={id:'source',mime:'text/markdown',hash:hash(bytes),text};resume.structureContexts=resumeStructureContexts(resume,bytes);
 assert.equal(resumePassageContext(resume,'- Built a simulated sensor prototype.'),'projects|sensor prototype');
 assert.equal(passageContext(text,'- Built a simulated sensor prototype.',resume.structureContexts),'projects|sensor prototype');
 assert.equal(resumePassageContext({...resume,hash:hash('different bytes')},'- Built a simulated sensor prototype.'),null);
 assert.equal(passageContext(text+'Changed text','- Built a simulated sensor prototype.',resume.structureContexts),null);
 assert.throws(()=>resumeStructureContexts({...resume,hash:hash('wrong')},bytes),/imported hash/);
 assert.equal(passageContext('Projects\nDifferent project\nAcademic project | 2026\nMeasured 12 cases.','Measured 12 cases.'),null,'Legacy date metadata cannot become a project identity');
});

test('unsupported native table layouts cannot use date fallback, while unchanged finished reuse still works',async t=>{
 const ctx=await fixture(t),service=new ResumeService(ctx),f=contextualDocx([{title:'Sensor prototype',items:[metadata,{text:nativeOriginal,bullet:true},{text:nativeMetric,bullet:true}]},{title:'Robot prototype',items:[metadata,{text:nativeMetric.replace('12','20'),bullet:true}]}]);
 f.files['word/document.xml']=strToU8(strFromU8(f.files['word/document.xml']).replace(f.projectXml,'<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid><w:tr><w:tc><w:tcPr/>'+f.projectXml+'</w:tc></w:tr></w:tbl>'));
 const bytes=Buffer.from(zipSync(f.files)),imported=await service.import([{name:'Native table.docx',content:bytes.toString('base64')}]);assert.equal(imported.imported,1,JSON.stringify(imported));const resume=ctx.store.list('resume')[0];
 assert.deepEqual(resume.structureContexts.passages,{});assert.equal(resumePassageContext(resume,nativeOriginal),null);assert.equal(resumePassageContext({...resume,structureContexts:undefined},nativeOriginal),null);assert(!ctx.store.list('fact').some(fact=>fact.conflict),'Unknown project scope cannot prove the two distinct projects contradict one another');
 const pkg=await service.select(postingJob(ctx.store,{id:'job'}),resume.id);assert.equal(pkg.verified,true);assert.deepEqual(await readFile(pkg.finalPath),bytes);
});
