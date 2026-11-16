import '../server/runtime.mjs';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {renderDocx,extract} from '../server/resumes.mjs';

// Diagnose the hosted renderer before parallel fixture work starts. This uses
// synthetic text and the production conversion/extraction path, never a profile.
let directory;
try{
 const {stdout}=await promisify(execFile)(process.env.HUB_SOFFICE_BIN||'soffice',['--version'],{timeout:15000,maxBuffer:8192});
 const version=stdout.match(/LibreOffice(?:Dev)? [0-9][0-9A-Za-z .-]*/)?.[0]?.trim();assert(version,'Renderer version was not identified');
 directory=await mkdtemp(path.join(tmpdir(),'hub-renderer-check-'));
 const text='Synthetic renderer check. This is a controlled simulation.';
 const files={
  '[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rDoc" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml':`<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr></w:body></w:document>`
 };
 const input=path.join(directory,'synthetic.docx'),output=path.join(directory,'synthetic.pdf');
 await writeFile(input,zipSync(Object.fromEntries(Object.entries(files).map(([name,value])=>[name,strToU8(value)]))),{mode:0o600});
 await renderDocx(input,output);const result=await extract(output,'application/pdf');assert(result.text.replace(/\s+/g,' ').includes(text));assert.equal(result.pages,1);
 console.log(JSON.stringify({renderer:version,syntheticDocxToPdf:'passed',extractedText:'matched',pages:result.pages}));
}catch(error){console.error('Document renderer preflight failed:',error.code||'renderer_unavailable');process.exitCode=1;}
finally{if(directory)await rm(directory,{recursive:true,force:true});}
