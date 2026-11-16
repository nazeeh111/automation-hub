import {mkdir,writeFile,open,rm,lstat,chmod} from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {extract,renderText,renderDocx,normalize} from './resumes.mjs';
import {fileAccepts} from './posting-requirements.mjs';
import {supportingBinding,supportingDocumentMatches} from './supporting-policy.mjs';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fault=(message,code='supporting_document')=>Object.assign(new Error(message),{code,status:409});
const types={'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.txt':'text/plain'};
function fileBytes(file){
 if(!file||typeof file.name!=='string'||!file.name.trim()||file.name.length>200||/[\\/\x00-\x1f]/.test(file.name))throw fault('Choose one named PDF, DOCX or TXT file.');
 const name=file.name.trim(),extension=path.extname(name).toLowerCase(),mime=types[extension];if(!mime)throw fault('Supporting uploads currently accept PDF, DOCX and TXT. Other formats require manual completion.');
 if(typeof file.content!=='string'||file.content.length>17*1024*1024||!/^[A-Za-z0-9+/=\r\n]*$/.test(file.content))throw fault('The supporting file is invalid or exceeds 12 MB.');
 const encoded=file.content.replace(/[\r\n]/g,''),bytes=Buffer.from(encoded,'base64');if(!bytes.length||bytes.length>12*1024*1024||bytes.toString('base64')!==encoded)throw fault('The supporting file is invalid or exceeds 12 MB.');
 if(extension==='.pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw fault('This file is not a PDF.');
 if(extension==='.docx'&&!bytes.subarray(0,4).equals(Buffer.from([0x50,0x4b,3,4])))throw fault('This file is not a DOCX archive.');
 if(extension==='.txt'){try{const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(!text.trim()||text.includes('\0')||/[\x01-\x08\x0b\x0c\x0e-\x1f]/.test(text))throw new Error();}catch{throw fault('TXT files must contain readable UTF-8 text.');}}
 return {name,extension,mime,bytes,hash:digest(bytes)};
}
async function readDocumentFile(file){
 let handle;try{
  handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await handle.stat();
  if(!info.isFile()||info.size>12*1024*1024||(info.mode&0o777)!==0o600||typeof process.getuid==='function'&&info.uid!==process.getuid())throw new Error();
  const chunks=[];let total=0;for(;;){const buffer=Buffer.allocUnsafe(65536);const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;total+=bytesRead;if(total>12*1024*1024)throw new Error();chunks.push(buffer.subarray(0,bytesRead));}
  return Buffer.concat(chunks,total);
 }catch{throw fault('The retained supporting file is missing, changed or no longer private. Reattach a reviewed file.','supporting_document_changed');}
 finally{await handle?.close();}
}
export function verifySupportingRender(parsed,preview){
 const content=value=>normalize(String(value||'').replace(/^#{1,6}\s*/gm,'').replace(/^[-*]\s*/gm,''));
 const expected=content(parsed.text);
 // PDF extraction turns a physical line break after an existing hard hyphen
 // into a space. Join only the exact source-supported token, retaining its
 // hyphen, then require complete text equality. No dehyphenation or token loss.
 const extracted=String(preview.text||'').replace(/(\S+-)[ \t]*\r?\n[ \t]*(\S+)/g,(whole,left,right)=>expected.includes(left+right)?left+right:whole);
 if(expected!==content(extracted))throw fault('The preview changed source text. Supply a verified PDF or continue manually.');
 if((parsed.links||[]).some(link=>!(preview.links||[]).includes(link)))throw fault('The preview lost an original link. Supply a verified PDF or continue manually.');
}
export class SupportingDocumentService{
 constructor({store,directory}={}){if(!store||!path.isAbsolute(directory||''))throw fault('Supporting files need an absolute private application directory.');Object.assign(this,{store,directory,epoch:0,closed:false});}
 close(){this.closed=true;this.epoch++;}
 context(decisionId,questionLabel){
  if(this.closed)throw fault('Supporting file service was closed.','supporting_document_stale');
  const decision=this.store.get('decision',decisionId),job=decision&&this.store.get('job',decision.jobId),profile=this.store.get('profile','main'),pkg=job&&this.store.get('package',job.packageId);
  if(!decision||decision.state!=='open'||decision.code!=='form_questions'||!job||job.state!=='needs_you'||!pkg?.verified||!pkg.hash||pkg.jobId!==job.id)throw fault('Attach files only to the current open employer document question.','supporting_document_scope');
  if(pkg.profileRevision&&pkg.profileRevision!==profile?.updatedAt)throw fault('The candidate changed after preparation. Prepare the current application again.','supporting_document_scope');
  const matches=(decision.details?.questions||[]).filter(question=>question.label===questionLabel&&question.kind==='document');if(matches.length!==1)throw fault('This employer upload question is missing or ambiguous.','supporting_document_scope');
  const question=matches[0],binding=supportingBinding({job,profile,question});
  return {decision,job,profile,pkg,question,binding,generation:JSON.stringify({decision,job,profile,pkg}),epoch:this.epoch};
 }
 guard(snapshot){const current=this.context(snapshot.decision.id,snapshot.question.label);if(current.epoch!==snapshot.epoch||current.generation!==snapshot.generation)throw fault('The application, question, profile or document changed during attachment. Review the current question.','supporting_document_stale');return current;}
 async verifyStored(document){
  if(!/^supporting-[a-f0-9-]{36}$/.test(document.id||''))throw fault('The supporting file identity is invalid.','supporting_document_changed');const root=path.join(this.directory,'supporting-documents'),expected=path.join(root,document.id);for(const folder of [root,expected]){let info;try{info=await lstat(folder);}catch{throw fault('The retained supporting file directory is missing.','supporting_document_changed');}if(!info.isDirectory()||info.isSymbolicLink()||(info.mode&0o777)!==0o700||typeof process.getuid==='function'&&info.uid!==process.getuid())throw fault('The retained supporting file location changed.','supporting_document_changed');}if(!document.originalPath||path.dirname(document.originalPath)!==expected||document.previewPath&&path.dirname(document.previewPath)!==expected)throw fault('The retained supporting file has an invalid private location.','supporting_document_changed');
  for(const [file,hash] of [[document.originalPath,document.hash],[document.previewPath,document.previewHash]]){if(!file)continue;const bytes=await readDocumentFile(file);if(digest(bytes)!==hash)throw fault('The retained supporting file changed after review. Reattach a reviewed file.','supporting_document_changed');}
 }
 async attach({decisionId,questionLabel,file,confirmed,expectedBinding}={}){
  if(confirmed!==true)throw fault('Review this exact file for the candidate, employer and question before attaching it.','supporting_document_review');
  const snapshot=this.context(decisionId,questionLabel);
  if(expectedBinding!==undefined){const fields=['jobId','questionHash','packageId','postingHash','profileRevision'];if(!expectedBinding||typeof expectedBinding!=='object'||Array.isArray(expectedBinding)||Object.keys(expectedBinding).length!==fields.length||fields.some(key=>typeof expectedBinding[key]!=='string'||expectedBinding[key]!==snapshot.binding[key]))throw fault('The reviewed upload context changed before attachment. Review the current candidate, question and document again.','supporting_document_stale');}
  const input=fileBytes(file);
  if(!fileAccepts({accept:snapshot.question.accept,name:input.name,mime:input.mime}))throw fault('This employer upload control does not accept the chosen file format.','supporting_document_format');
  const existing=this.store.list('supportingDocument').find(document=>document.hash===input.hash&&document.name===input.name&&supportingDocumentMatches(document,snapshot));
  if(existing){await this.verifyStored(existing);this.guard(snapshot);const ref=snapshot.job.supportingDocuments?.[snapshot.binding.questionHash];if(ref?.documentId===existing.id&&ref.hash===existing.hash)return existing;this.save(snapshot,existing);return existing;}
  const id='supporting-'+randomUUID(),base=path.join(this.directory,'supporting-documents'),directory=path.join(base,id);let owned=false;
  try{
   await mkdir(base,{recursive:true,mode:0o700});const baseInfo=await lstat(base);if(!baseInfo.isDirectory()||baseInfo.isSymbolicLink()||typeof process.getuid==='function'&&baseInfo.uid!==process.getuid())throw fault('Supporting file storage is not a private owned directory.');await chmod(base,0o700);this.guard(snapshot);
   await mkdir(directory,{mode:0o700});owned=true;const originalPath=path.join(directory,'original'+input.extension);await writeFile(originalPath,input.bytes,{mode:0o600,flag:'wx'});this.guard(snapshot);
   const parsed=await extract(originalPath,input.mime);this.guard(snapshot);let previewPath,preview;
   if(input.extension==='.pdf'){previewPath=originalPath;preview=parsed;}else{previewPath=path.join(directory,'preview.pdf');input.extension==='.docx'?await renderDocx(originalPath,previewPath):await renderText(parsed.text,previewPath);this.guard(snapshot);await chmod(previewPath,0o600);preview=await extract(previewPath,'application/pdf');this.guard(snapshot);verifySupportingRender(parsed,preview);}
   if(!Number.isInteger(preview.pages)||preview.pages<1)throw fault('The supporting document has no verified rendered pages.');
   const originalBytes=await readDocumentFile(originalPath);this.guard(snapshot);if(digest(originalBytes)!==input.hash)throw fault('The source file changed while it was being checked.','supporting_document_changed');
   const previewBytes=await readDocumentFile(previewPath);this.guard(snapshot);const reviewedAt=new Date().toISOString();
   const document={id,name:input.name,mime:input.mime,hash:input.hash,bytes:input.bytes.length,originalPath,previewPath,previewHash:digest(previewBytes),text:parsed.text||'',links:parsed.links||[],pages:preview.pages,verified:true,renderVerification:{parsed:true,preview:true,text:Boolean(String(parsed.text||'').trim()),links:true,humanReview:true,scanned:input.extension==='.pdf'&&!String(parsed.text||'').trim(),ocr:false},binding:snapshot.binding,reviewedAt,createdAt:reviewedAt};
   this.save(snapshot,document);return document;
  }catch(error){if(owned)await rm(directory,{recursive:true,force:true});throw error;}
 }
 save(snapshot,document){
  this.store.transaction(()=>{this.guard(snapshot);this.store.put('supportingDocument',document);this.store.put('job',{...snapshot.job,supportingDocuments:{...snapshot.job.supportingDocuments,[snapshot.binding.questionHash]:{documentId:document.id,hash:document.hash,questionHash:snapshot.binding.questionHash}},revision:(snapshot.job.revision||0)+1,state:'needs_you',nextAction:'Review the supporting document and answer the remaining employer questions'});this.store.event(snapshot.job.id,'supporting_document_attached',{documentId:document.id,hash:document.hash,questionHash:snapshot.binding.questionHash});});
 }
}
