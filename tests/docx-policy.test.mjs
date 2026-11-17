import {postingJob} from './fixtures/posting.mjs';
import '../server/runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {getDocument,OPS} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {assertDocxResources} from '../server/docx-policy.mjs';
import {ResumeService,renderDocx,extract,hash} from '../server/resumes.mjs';
import {Store} from '../server/store.mjs';

const NS='http://schemas.openxmlformats.org/package/2006/relationships',REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const esc=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
// Owned synthetic 64px image used in the actual positive resource probe.
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAC0SURBVHic7dvBDcMwDMDAOOgg7iYZvZvUm7Q7NAXuYfIvgSD01ZjX+hwbc2oBTQG0gKYAWkBTAC2gKYAW0BRAC2gKoAU0BdACmsfdBe9r/sfkR56vdWt++wsogBbQFEALaAqgBTQF0AKaAmgBTQG0gKYAWkBTAC2gKYAW0BRAC2gKoAU0BdACmgJoAU0BtICmAFpAM/oX2JwCaAFNAbSApgBaQFMALaApgBbQFEALaAqgBTRf8yUH/8wfdj4AAAAASUVORK5CYII=','base64');
const jpeg=Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCABAAEADASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFwEBAQEBAAAAAAAAAAAAAAAAAAkHCP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJsAdxsyAAAAAAAAWgAhyokAAi8BcZO0ABaACHKiQACLwFxk7QAAAAAAAH//2Q==','base64');
function fixture({external=null,links=[],prefix='',quote='"',rawRelationship=null}={}){
 const tag=prefix?prefix+':':'',attribute=(name,value)=>`${name}=${quote}${esc(value)}${quote}`;
 const relation=(id,type,target,mode)=>`<${tag}Relationship ${attribute('Id',id)} ${attribute('Type',REL+type)} ${attribute('Target',target)}${mode?' '+attribute('TargetMode',mode):''}/>`;
 const relationships=`<${tag}Relationships xmlns${prefix?':'+prefix:''}=${quote}${NS}${quote}>${relation('styles','styles','styles.xml')}${relation('image','image',external||'media/image.png',external?'External':null)}${links.map((target,index)=>relation('link'+index,'hyperlink',target,'External')).join('')}${rawRelationship||''}</${tag}Relationships>`;
 const files={
  '[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
  '_rels/.rels':strToU8(`<Relationships xmlns="${NS}"><Relationship Id="document" Type="${REL}officeDocument" Target="word/document.xml"/></Relationships>`),
  'word/_rels/document.xml.rels':strToU8(relationships),
  'word/styles.xml':strToU8('<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style></w:styles>'),
  'word/document.xml':strToU8(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${REL.slice(0,-1)}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>Alex Example</w:t></w:r></w:p><w:p><w:r><w:t>Built a simulated sensor prototype in Python.</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Image"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="0" name="Image"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:${external?'link':'embed'}="image"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>${links.map((_,index)=>`<w:p><w:hyperlink r:id="link${index}"><w:r><w:t>Source link ${index}</w:t></w:r></w:hyperlink></w:p>`).join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`)
 };
 if(!external)files['word/media/image.png']=png;
 return {files,bytes:()=>Buffer.from(zipSync(files))};
}
async function temporary(t){const directory=await mkdtemp(path.join(tmpdir(),'hub-docx-policy-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
function policyHold(fn){assert.throws(fn,error=>error.code==='docx_resource_review'&&error.hold&&/original|embedded/.test(error.message));}
async function noDispatch(t,directory){
 const sentinel=path.join(directory,'dispatched'),executable=path.join(directory,'renderer-sentinel.mjs'),previous=process.env.HUB_SOFFICE_BIN;
 await writeFile(executable,`#!${process.execPath}\nimport {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(sentinel)},'dispatch\\n');process.exit(2);\n`,{mode:0o700});
 process.env.HUB_SOFFICE_BIN=executable;t.after(()=>{if(previous===undefined)delete process.env.HUB_SOFFICE_BIN;else process.env.HUB_SOFFICE_BIN=previous;});
 // Prove this executable records a dispatch when an admitted file reaches it.
 const valid=path.join(directory,'sentinel-control.docx');await writeFile(valid,fixture().bytes());await assert.rejects(renderDocx(valid,path.join(directory,'sentinel-control.pdf')));assert.match(await readFile(sentinel,'utf8'),/dispatch/);await rm(sentinel);
 return async()=>assert.rejects(access(sentinel),error=>error.code==='ENOENT');
}

test('contained resources and public web/email hyperlinks survive namespace aliases, single quotes and XML entities',()=>{
 const links=['https://example.invalid/sensor?one=1&two=2#result','mailto:alex@example.invalid'],f=fixture({links,prefix:'p',quote:"'"});
 f.files['word/_rels/document.xml.rels']=strToU8(strFromU8(f.files['word/_rels/document.xml.rels']).replace('media/image.png','media/ima&#x67;e.png'));
 const bytes=f.bytes(),before=Buffer.from(bytes),result=assertDocxResources(bytes);assert.deepEqual(result.hyperlinks,links);assert.equal(result.relationships,5);assert.deepEqual(bytes,before,'Resource validation must preserve the exact input archive bytes');
});
test('external image references hold regardless of quotes, namespace prefix or character references',()=>{
 for(const target of ['file:///owned/synthetic.png','http://127.0.0.1:12345/synthetic.png']){
  const f=fixture({external:target,prefix:'q',quote:"'"});f.files['word/_rels/document.xml.rels']=strToU8(strFromU8(f.files['word/_rels/document.xml.rels']).replace("TargetMode='External'","TargetMode='Exter&#110;al'").replace('/relationships/image','/relationships/ima&#103;e'));
  policyHold(()=>assertDocxResources(f.bytes()));
 }
});
test('all relationship parts are checked, including an external settings template and header resource',()=>{
 for(const [part,type] of [['settings','attachedTemplate'],['header1','image']]){
  const f=fixture();f.files[`word/${part}.xml`]=strToU8('<owned/>');f.files[`word/_rels/${part}.xml.rels`]=strToU8(`<Relationships xmlns="${NS}"><Relationship Id="outside" Type="${REL+type}" Target="file:///owned/resource" TargetMode="External"/></Relationships>`);policyHold(()=>assertDocxResources(f.bytes()));
 }
});
test('internal resources must resolve to contained package entries rather than file paths or traversal',()=>{
 for(const target of ['../../owned/image.png','file:///owned/image.png','http://127.0.0.1/image.png','%2e%2e/%2e%2e/owned.png','%252e%252e/owned.png','missing.png','//localhost/owned.png']){
  const f=fixture();f.files['word/_rels/document.xml.rels']=strToU8(strFromU8(f.files['word/_rels/document.xml.rels']).replace('media/image.png',target));policyHold(()=>assertDocxResources(f.bytes()));
 }
 const f=fixture();f.files['word/_rels/document.xml.rels']=strToU8(strFromU8(f.files['word/_rels/document.xml.rels']).replace('media/image.png','/word/media/image.png'));assertDocxResources(f.bytes());
});
test('malformed namespaces, duplicate identifiers, entity declarations and oversized metadata fail closed',()=>{
 const variants=[text=>text.replace(NS,'urn:unexpected'),text=>text.replace('Id="image"','Id="styles"'),text=>'<!DOCTYPE Relationships [<!ENTITY outside SYSTEM "file:///owned/source">]>'+text,text=>text.replace('Target="media/image.png"','Target=media/image.png'),text=>text.replace('</Relationships>','<extra/></Relationships>'),text=>text.replace('</Relationships>','<!--'+'x'.repeat(1024*1024)+'--></Relationships>')];
 for(const change of variants){const f=fixture();f.files['word/_rels/document.xml.rels']=strToU8(change(strFromU8(f.files['word/_rels/document.xml.rels'])));policyHold(()=>assertDocxResources(f.bytes()));}
 const f=fixture();f.files['../outside.xml']=strToU8('<outside/>');policyHold(()=>assertDocxResources(f.bytes()));
});
test('UTF16 relationship metadata is namespace parsed and does not bypass external-resource review',()=>{
 for(const external of [null,'file:///owned/image.png']){const f=fixture({external,prefix:'r',quote:"'"}),text='<?xml version="1.0" encoding="UTF-16"?>'+strFromU8(f.files['word/_rels/document.xml.rels']);f.files['word/_rels/document.xml.rels']=Buffer.concat([Buffer.from([0xff,0xfe]),Buffer.from(text,'utf16le')]);if(external)policyHold(()=>assertDocxResources(f.bytes()));else assertDocxResources(f.bytes());}
});
test('local, credentialed and active hyperlinks are not admitted as ordinary public hyperlinks',()=>{
 for(const link of ['file:///owned/file','javascript:alert(1)','http://localhost/file','http://127.0.0.1/file','http://0x7f000001/file','http://[::1]/file','https://user:secret@example.invalid/file','mailto:alex@example.invalid%0d%0aBcc:other@example.invalid'])policyHold(()=>assertDocxResources(fixture({links:[link]}).bytes()));
 assertDocxResources(fixture({links:['https://8.8.8.8/','https://[2606:4700:4700::1111]/']}).bytes());
});
test('actual embedded image and public hyperlinks render to PDF without changing the original DOCX',async t=>{
 const directory=await temporary(t),f=fixture({links:['https://example.invalid/sensor?version=1','mailto:alex@example.invalid']}),bytes=f.bytes(),file=path.join(directory,'finished.docx'),pdf=path.join(directory,'preview.pdf');await writeFile(file,bytes);await renderDocx(file,pdf);
 assert.deepEqual(await readFile(file),bytes);const extracted=await extract(pdf,'application/pdf');assert.match(extracted.text,/Alex Example/);assert.match(extracted.text,/simulated sensor prototype/);assert.deepEqual(new Set(extracted.links),new Set(['https://example.invalid/sensor?version=1','mailto:alex@example.invalid']));
 const task=getDocument({data:new Uint8Array(await readFile(pdf)),isEvalSupported:false,useSystemFonts:true}),doc=await task.promise,page=await doc.getPage(1),ops=await page.getOperatorList();assert(ops.fnArray.some(op=>[OPS.paintImageXObject,OPS.paintInlineImageXObject].includes(op)),'The valid embedded-image control must actually render');await task.destroy();
});
test('ordinary embedded JPEG and a JPEG thumbnail remain supported and render actual image content',async t=>{
 const directory=await temporary(t),f=fixture();delete f.files['word/media/image.png'];f.files['word/media/image.jpg']=jpeg;f.files['docProps/thumbnail.jpg']=jpeg;
 f.files['word/_rels/document.xml.rels']=strToU8(strFromU8(f.files['word/_rels/document.xml.rels']).replace('media/image.png','media/image.jpg'));
 f.files['[Content_Types].xml']=strToU8(strFromU8(f.files['[Content_Types].xml']).replace('<Default Extension="png" ContentType="image/png"/>','<Default Extension="jpg" ContentType="image/jpeg"/>'));
 f.files['_rels/.rels']=strToU8(strFromU8(f.files['_rels/.rels']).replace('</Relationships>','<Relationship Id="thumbnail" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail" Target="docProps/thumbnail.jpg"/></Relationships>'));
 const bytes=f.bytes();assert.equal(assertDocxResources(bytes).images,2);const file=path.join(directory,'jpeg.docx'),pdf=path.join(directory,'jpeg.pdf');await writeFile(file,bytes);await renderDocx(file,pdf);assert.deepEqual(await readFile(file),bytes);
 const task=getDocument({data:new Uint8Array(await readFile(pdf)),isEvalSupported:false,useSystemFonts:true}),doc=await task.promise,ops=await(await doc.getPage(1)).getOperatorList();assert(ops.fnArray.some(op=>[OPS.paintImageXObject,OPS.paintInlineImageXObject].includes(op)));await task.destroy();
});
test('SVG images and SVG disguised with PNG or JPEG metadata hold before renderer dispatch',async t=>{
 const directory=await temporary(t),assertNoDispatch=await noDispatch(t,directory),svg=strToU8('<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="file:///owned/never-read.png"/></svg>');
 for(const format of ['svg','png','jpg']){
  const f=fixture();delete f.files['word/media/image.png'];f.files['word/media/image.'+format]=svg;f.files['word/_rels/document.xml.rels']=strToU8(strFromU8(f.files['word/_rels/document.xml.rels']).replace('media/image.png','media/image.'+format));f.files['[Content_Types].xml']=strToU8(strFromU8(f.files['[Content_Types].xml']).replace('<Default Extension="png" ContentType="image/png"/>',`<Default Extension="${format}" ContentType="${format==='svg'?'image/svg+xml':format==='jpg'?'image/jpeg':'image/png'}"/>`));const file=path.join(directory,'opaque-'+format+'.docx');await writeFile(file,f.bytes());await assert.rejects(renderDocx(file,path.join(directory,'opaque-'+format+'.pdf')),error=>error.code==='docx_resource_review'&&error.resourceReason==='embedded_image_format'&&/PNG\/JPEG/.test(error.message));
 }
 await assertNoDispatch();
});
test('HTML imports, embedded OLE/package parts and spoofed thumbnails hold before renderer dispatch',async t=>{
 const directory=await temporary(t),assertNoDispatch=await noDispatch(t,directory);
 for(const [name,type,part,contentType,data] of [
  ['html','aFChunk','word/chunk.html','text/html',strToU8('<html><img src="file:///owned/never-read.png"></html>')],
  ['ole','oleObject','word/object.bin','application/vnd.openxmlformats-officedocument.oleObject',Buffer.from([0xd0,0xcf,0x11,0xe0,0xa1,0xb1,0x1a,0xe1])],
  ['package','package','word/embeddings/book.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',strToU8('owned synthetic unsupported package')],
  ['thumbnail','thumbnail','docProps/thumbnail.png','image/png',strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>')]
 ]){
  const f=fixture(),target=part.startsWith('word/')?part.slice(5):'../'+part;f.files[part]=data;f.files['word/_rels/document.xml.rels']=strToU8(strFromU8(f.files['word/_rels/document.xml.rels']).replace('</Relationships>',`<Relationship Id="opaque" Type="${REL+type}" Target="${target}"/></Relationships>`));f.files['[Content_Types].xml']=strToU8(strFromU8(f.files['[Content_Types].xml']).replace('</Types>',`<Override PartName="/${part}" ContentType="${contentType}"/></Types>`));const file=path.join(directory,name+'.docx');await writeFile(file,f.bytes());await assert.rejects(renderDocx(file,path.join(directory,name+'.pdf')),error=>error.code==='docx_resource_review');
 }
 await assertNoDispatch();
});
test('content-type namespaces and claimed image formats must agree with actual contained bytes',()=>{
 for(const change of [text=>text.replace('http://schemas.openxmlformats.org/package/2006/content-types','urn:unexpected'),text=>text.replace('image/png','image/jpeg'),text=>text.replace('</Types>','<Default Extension="png" ContentType="image/png"/></Types>')]){const f=fixture();f.files['[Content_Types].xml']=strToU8(change(strFromU8(f.files['[Content_Types].xml'])));policyHold(()=>assertDocxResources(f.bytes()));}
 const f=fixture();f.files['word/media/image.png']=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),strToU8('<svg xmlns="http://www.w3.org/2000/svg"/>')]);policyHold(()=>assertDocxResources(f.bytes()));
});
test('actual image-use IDs cannot disguise SVG as a generic internal hyperlink part',async t=>{
 const directory=await temporary(t),assertNoDispatch=await noDispatch(t,directory),f=fixture();delete f.files['word/media/image.png'];f.files['word/media/opaque.bin']=strToU8('<svg xmlns="http://www.w3.org/2000/svg"><image href="file:///owned/never-read.png"/></svg>');
 f.files['word/_rels/document.xml.rels']=strToU8(strFromU8(f.files['word/_rels/document.xml.rels']).replace('relationships/image','relationships/hyperlink').replace('media/image.png','media/opaque.bin'));
 f.files['[Content_Types].xml']=strToU8(strFromU8(f.files['[Content_Types].xml']).replace('</Types>','<Default Extension="bin" ContentType="application/octet-stream"/></Types>'));
 const file=path.join(directory,'disguised.docx');await writeFile(file,f.bytes());await assert.rejects(renderDocx(file,path.join(directory,'disguised.pdf')),error=>error.code==='docx_resource_review'&&error.resourceReason==='embedded_image_format');await assertNoDispatch();
});
test('actual imported-HTML and OLE markup hold even with generic content and a spoofed hyperlink relationship',async t=>{
 const directory=await temporary(t),assertNoDispatch=await noDispatch(t,directory);
 for(const [name,markup] of [['html','<w:altChunk r:id="imported"/>'],['ole','<w:p><w:r><w:object><o:OLEObject Type="Embed" r:id="imported"/></w:object></w:r></w:p>']]){
  const f=fixture();f.files['word/opaque.bin']=strToU8('Synthetic unsupported rich content');f.files['word/document.xml']=strToU8(strFromU8(f.files['word/document.xml']).replace('<w:document ','<w:document xmlns:o="urn:schemas-microsoft-com:office:office" ').replace('<w:sectPr>',markup+'<w:sectPr>'));
  f.files['word/_rels/document.xml.rels']=strToU8(strFromU8(f.files['word/_rels/document.xml.rels']).replace('</Relationships>',`<Relationship Id="imported" Type="${REL}hyperlink" Target="opaque.bin"/></Relationships>`));f.files['[Content_Types].xml']=strToU8(strFromU8(f.files['[Content_Types].xml']).replace('</Types>','<Default Extension="bin" ContentType="application/octet-stream"/></Types>'));
  const file=path.join(directory,name+'-markup.docx');await writeFile(file,f.bytes());await assert.rejects(renderDocx(file,path.join(directory,name+'-markup.pdf')),error=>error.code==='docx_resource_review'&&error.resourceReason==='embedded_format');
 }
 await assertNoDispatch();
});
test('external local/HTTP images are held before renderer dispatch and never contact the listener',async t=>{
 const directory=await temporary(t),assertNoDispatch=await noDispatch(t,directory),requests=[];const server=createServer((req,res)=>{requests.push(req.url);res.end(png);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));const local=path.join(directory,'owned.png');await writeFile(local,png);
 for(const [i,target] of [pathToFileURL(local).href,`http://127.0.0.1:${server.address().port}/image.png`].entries()){const file=path.join(directory,'held'+i+'.docx');await writeFile(file,fixture({external:target}).bytes());await assert.rejects(renderDocx(file,path.join(directory,'held'+i+'.pdf')),error=>error.code==='docx_resource_review');}
 await assertNoDispatch();assert.equal(requests.length,0);
});
test('held import preserves immutable original and safe raw facts, with no preview, package or renderer invocation',async t=>{
 const directory=await temporary(t),assertNoDispatch=await noDispatch(t,directory),store=new Store(directory);t.after(()=>store.close());store.put('profile',{id:'main',fullName:'Alex Example',email:'alex@example.invalid'});const service=new ResumeService({store,directory}),bytes=fixture({external:'file:///owned/synthetic-private-image.png'}).bytes();
 assert.equal((await service.import([{name:'Linked resume.docx',content:bytes.toString('base64')}])).imported,1);const resume=store.list('resume')[0];assert.equal(resume.renderStatus,'needs_resource_review');assert.equal(resume.renderCode,'docx_resource_review');assert.match(resume.renderError,/external image/);assert.equal(resume.previewPath,null);assert.match(resume.text,/simulated sensor prototype/);assert(store.list('fact').some(f=>f.text.includes('simulated sensor')));assert.deepEqual(await readFile(resume.originalPath),bytes);
 await assert.rejects(service.select(postingJob(store,{id:'synthetic-job'}),resume.id),error=>error.code==='docx_resource_review');assert.equal(store.list('package').length,0);assert(!store.list('event').some(event=>event.type==='package_prepared'));await assertNoDispatch();
});
test('LibreOffice receives an exact checked snapshot if a caller replaces its source after validation',async t=>{
 const directory=await temporary(t),file=path.join(directory,'original.docx'),output=path.join(directory,'preview.pdf'),record=path.join(directory,'snapshot.json'),executable=path.join(directory,'snapshot-renderer.mjs'),bytes=fixture().bytes(),changed=fixture({external:'file:///owned/image.png'}).bytes();await writeFile(file,bytes);
 const previous=process.env.HUB_SOFFICE_BIN;t.after(()=>{if(previous===undefined)delete process.env.HUB_SOFFICE_BIN;else process.env.HUB_SOFFICE_BIN=previous;});
 await writeFile(executable,`#!${process.execPath}\nimport{readFileSync,writeFileSync,statSync}from'node:fs';import{createHash}from'node:crypto';const checked=process.argv.at(-1);writeFileSync(${JSON.stringify(file)},Buffer.from(${JSON.stringify(changed.toString('base64'))},'base64'));writeFileSync(${JSON.stringify(record)},JSON.stringify({checked,hash:createHash('sha256').update(readFileSync(checked)).digest('hex'),mode:statSync(checked).mode&511}));process.exit(2);\n`,{mode:0o700});process.env.HUB_SOFFICE_BIN=executable;
 await assert.rejects(renderDocx(file,output));const observed=JSON.parse(await readFile(record,'utf8'));assert.notEqual(observed.checked,file);assert.equal(observed.hash,hash(bytes));assert.equal(observed.mode,0o600);assert.deepEqual(await readFile(file),changed);
});
