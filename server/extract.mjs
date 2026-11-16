import { parentPort,workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { unzipSync,strFromU8 } from 'fflate';
try {
 const {file,mime}=workerData;const bytes=await readFile(file);if(bytes.length>12*1024*1024)throw new Error('Document exceeds 12 MB.');let result;
 if(mime==='application/pdf'){
  const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');const doc=await getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true}).promise;
  if(doc.numPages>20)throw new Error('Application resume exceeds the 20-page extraction limit.');
  const lines=[],links=[];for(let i=1;i<=doc.numPages;i++){const page=await doc.getPage(i),content=await page.getTextContent();let line='',lastY=null;for(const item of content.items){if(typeof item.str!=='string')continue;const y=Math.round(item.transform[5]);if(lastY!==null&&Math.abs(y-lastY)>3&&line){lines.push(line.trim());line='';}line+=(line?' ':'')+item.str;lastY=y;if(item.hasEOL){lines.push(line.trim());line='';lastY=null;}}if(line)lines.push(line.trim());for(const a of await page.getAnnotations()){if(a.url&&/^https?:|^mailto:/i.test(a.url))links.push(a.url);}if(lines.join('\n').length>200000)throw new Error('Extracted text exceeds 200,000 characters.');page.cleanup();}result={text:lines.join('\n'),pages:doc.numPages,links:[...new Set(links)]};await doc.cleanup();
 }else if(mime.includes('wordprocessingml')){
  let total=0;const files=unzipSync(new Uint8Array(bytes),{filter:f=>{total+=f.originalSize;if(total>60*1024*1024||f.originalSize>20*1024*1024)throw new Error('DOCX expanded content exceeds safe limits.');return f.name==='word/_rels/document.xml.rels';}});
  const mammoth=await import('mammoth');const {value}=await mammoth.default.extractRawText({buffer:bytes});const relationships=strFromU8(files['word/_rels/document.xml.rels']||new Uint8Array());const links=[...relationships.matchAll(/<Relationship\b[^>]*>/g)].map(m=>m[0]).filter(s=>/Type="[^"]*hyperlink"/.test(s)).map(s=>s.match(/Target="([^"]+)"/)?.[1]?.replace(/&amp;/g,'&')).filter(s=>s&&/^(https?:|mailto:)/i.test(s));result={text:value,links:[...new Set(links)],pages:null};
 }else {const text=bytes.toString('utf8');result={text,links:[...new Set(text.match(/(?:https?:\/\/|mailto:)[^\s<>"')]+/g)||[])],pages:null};}
 if(result.text.length>200000)throw new Error('Extracted text exceeds 200,000 characters.');if(result.text.includes('\0'))throw new Error('Document contains binary text.');parentPort.postMessage(result);
}catch(error){parentPort.postMessage({error:error.message});}
