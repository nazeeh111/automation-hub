import './runtime.mjs';
import { mkdir, writeFile, readFile, copyFile, rename, mkdtemp, rm, stat, open } from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { unzipSync,zipSync,strFromU8,strToU8 } from 'fflate';
import { fileAccepts } from './posting-requirements.mjs';
import {readOriginalResume,resumeStructureCatalog,resumeStructureContexts,restructureResume} from './resume-structure.mjs';
import {assertDocxResources} from './docx-policy.mjs';
import {assertRenderedText} from './render-integrity.mjs';
import {PostingObservations} from './posting-observations.mjs';
import {reasoningContext,reasoningQuestionHash,currentReasoningAnswers} from './reasoning-context.mjs';

export const hash=b=>createHash('sha256').update(b).digest('hex');
export const normalize=s=>s.normalize('NFKC').replace(/\s+/g,' ').trim();
const genericSections=new Set(['projects','experience','work experience','professional experience','education','skills','technical skills','summary','research','research experience','publications']);
export function passageContext(text,line,contexts){
 if(contexts!==undefined){
  if(!contexts||contexts.version!==1||contexts.textHash!==hash(text)||!contexts.passages||typeof contexts.passages!=='object')return null;
  const key=normalize(line).toLowerCase();return Object.hasOwn(contexts.passages,key)&&typeof contexts.passages[key]==='string'?contexts.passages[key]:null;
 }
 const lines=text.split('\n').map(normalize);const index=lines.indexOf(normalize(line));let section='',heading='';
 for(let i=0;i<index;i++){
  if(/^#{1,6}\s/.test(lines[i])||/^[A-Z][A-Z &/]{3,}$/.test(lines[i])){
   const title=lines[i].replace(/^#+\s*/,'').toLowerCase();
   if(genericSections.has(title)){section=title;heading='';}else heading=title;
  }
 }
 if(heading)return section+'|'+heading;
 const previous=lines.slice(0,index).filter(Boolean).at(-1)||'';
 if(!previous||/^[-*•]/.test(previous)||/\b(?:19|20)\d{2}\b/.test(previous)||/^(?:academic|team|course|personal) project\b|\b(?:phase|semester|simulation.only)\b/i.test(previous)||genericSections.has(previous.replace(/^#+\s*/,'').toLowerCase()))return null;
 return section+'|paragraph:'+previous.toLowerCase();
}
export function resumePassageContext(resume,line){
 const contexts=resume.structureContexts;
 if(contexts!==undefined&&contexts?.sourceHash!==resume.hash||contexts===undefined&&resume.mime?.includes('wordprocessingml'))return null;
 return passageContext(resume.text,line,contexts);
}
const linkify=s=>{let out='',at=0;const pattern=/(?:https?:\/\/|mailto:)[^\s<>\"')]+/g;for(const m of s.matchAll(pattern)){out+=esc(s.slice(at,m.index))+`<a href="${esc(m[0])}">${esc(m[0])}</a>`;at=m.index+m[0].length;}return out+esc(s.slice(at));};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now=()=>new Date().toISOString();
const problem=(message,code='resume_review')=>Object.assign(new Error(message),{code});
const integrityHeld=resume=>resume?.renderStatus==='needs_review'||resume?.renderCode==='render_integrity_review';
const usableFacts=(facts,resumes)=>{const held=new Set(resumes.filter(integrityHeld).map(resume=>resume.id));return facts.filter(fact=>!fact.suppressed).map(fact=>({...fact,sources:(fact.sources||[]).filter(source=>!held.has(source.resumeId))})).filter(fact=>fact.sources.length);};

// Untrusted parsers run in a disposable worker with a memory limit and deadline.
export async function extract(file,mime){
 return new Promise((resolve,reject)=>{
  const worker=new Worker(new URL('./extract.mjs',import.meta.url),{workerData:{file,mime},resourceLimits:{maxOldGenerationSizeMb:256}});
  const timer=setTimeout(()=>{worker.terminate();reject(problem('Document extraction exceeded 25 seconds. Import a simpler or text-based copy.','document_limit'));},25000);
  worker.once('message',r=>{clearTimeout(timer);worker.terminate();r.error?reject(problem(r.error,'document_invalid')):resolve(r);});
  worker.once('error',()=>{clearTimeout(timer);reject(problem('Could not safely extract this document. Try a simpler PDF, DOCX or Markdown copy.','document_invalid'));});
  worker.once('exit',code=>{if(code!==0){clearTimeout(timer);reject(problem('Document extraction stopped before completion.','document_invalid'));}});
 });
}

export function validateEdits(resume,facts,edits){
 if(!Array.isArray(edits)||edits.length>12)throw problem('Resume changes exceed the review limit.');
 const seen=new Set();let text=resume.text;
 for(const e of edits){
  if(!e.original||seen.has(e.original)||!resume.text.includes(e.original))throw problem('A proposed change does not match its original source.');
  if(text.split(e.original).length!==2)throw problem('A proposed edit is ambiguous in the original document.');
  const source=facts.find(f=>e.factIds?.includes(f.id)&&normalize(f.text)===normalize(e.replacement));
  if(!source)throw problem('A proposed claim has no exact supporting source passage.');
  if(!resumePassageContext(resume,e.original)||!source.sources.some(s=>s.context&&s.context===resumePassageContext(resume,e.original)))throw problem('A supported passage belongs to a different project or experience. Keep its original context.');
  if(source.conflict||source.suppressed)throw problem('Conflicting facts need your review before borrowing this passage.');
  // Full source passages retain dates, numbers, contribution and maturity qualifiers.
  if(!resume.text.split('\n').some(l=>normalize(l)===normalize(e.original)))throw problem('Edits must replace a complete source line.');
  seen.add(e.original);text=text.replace(e.original,source.text);
 }
 return text;
}

export function patchDocx(bytes,edits){
 let total=0;const files=unzipSync(new Uint8Array(bytes),{filter:f=>{total+=f.originalSize;if(total>60*1024*1024||f.originalSize>20*1024*1024)throw problem('DOCX expanded content is too large.');return true;}});
 let xml=strFromU8(files['word/document.xml']||new Uint8Array());if(!xml)throw problem('DOCX has no main document.');
 const decode=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
 for(const e of edits){let matches=0;xml=xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,p=>{
   const text=[...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map(m=>decode(m[1])).join('');
   if(normalize(text)!==normalize(e.original))return p;matches++;let first=true;
   return p.replace(/<w:t(?:\s[^>]*)?>[\s\S]*?<\/w:t>/g,()=>{const s=first?`<w:t xml:space="preserve">${esc(e.replacement)}</w:t>`:'<w:t></w:t>';first=false;return s;});
  });if(matches!==1)throw problem('This DOCX layout needs manual template editing; the source paragraph was not unique.');}
 files['word/document.xml']=strToU8(xml);return Buffer.from(zipSync(files));
}

export async function renderText(text,output){
 const browser=await chromium.launch({headless:true});let context;try{
  context=await browser.newContext();const page=await context.newPage();await page.route('**/*',r=>r.abort());
  const content=text.split('\n').map((line,i)=>{
   const cleaned=line.replace(/^#+\s*/, '');if(!line.trim())return '<div class="space"></div>';
   if(i===0||/^# /.test(line))return `<h1>${esc(cleaned)}</h1>`;
   if(/^##|^[A-Z][A-Z &/]{3,}$/.test(line))return `<h2>${esc(cleaned)}</h2>`;
   return `<p>${linkify(cleaned.replace(/^[-*]\s*/, ''))}</p>`;
  }).join('');
  await page.setContent(`<html><head><style>@page{size:Letter;margin:0.55in}a{color:inherit;text-decoration:none}body{font:10pt Arial,sans-serif;color:#111;line-height:1.28}h1{font-size:19pt;margin:0 0 8pt}h2{font-size:11pt;border-bottom:1px solid #555;margin:11pt 0 5pt}p{margin:3pt 0;white-space:pre-wrap}.space{height:3pt}</style></head><body>${content}</body></html>`);
  await page.pdf({path:output,format:'Letter',printBackground:true,tagged:true});
 }finally{try{await context?.close();}finally{await browser.close();}}
}

export async function renderDocx(file,output){
 let descriptor,bytes;
 try{
  descriptor=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const info=await descriptor.stat(),limit=12*1024*1024;
  if(!info.isFile()||info.size>limit)throw problem('Use a regular DOCX file of 12 MB or smaller.','document_limit');
  const chunks=[];let length=0;
  for(;;){const chunk=Buffer.alloc(Math.min(65536,limit-length+1)),result=await descriptor.read(chunk,0,chunk.length,null);if(!result.bytesRead)break;length+=result.bytesRead;if(length>limit)throw problem('The DOCX grew beyond the 12 MB document limit.','document_limit');chunks.push(chunk.subarray(0,result.bytesRead));}
  bytes=Buffer.concat(chunks,length);
 }finally{await descriptor?.close();}
 assertDocxResources(bytes);
 const dir=await mkdtemp(path.join(tmpdir(),'hub-docx-'));try{
  const profile=path.join(dir,'profile');const resultDir=path.join(dir,'pdf');await mkdir(resultDir);
  // Render only the checked snapshot, never a caller path that can change
  // between policy validation and LibreOffice opening the document.
  const checked=path.join(dir,'checked.docx');await writeFile(checked,bytes,{mode:0o600,flag:'wx'});
  await new Promise((resolve,reject)=>{const child=spawn(process.env.HUB_SOFFICE_BIN||'soffice',[`-env:UserInstallation=file://${profile}`,'--headless','--convert-to','pdf','--outdir',resultDir,checked],{stdio:'ignore'});const timer=setTimeout(()=>child.kill('SIGKILL'),30000);child.on('error',()=>{clearTimeout(timer);reject(problem('DOCX rendering needs LibreOffice. Set HUB_SOFFICE_BIN or import a PDF.','renderer_missing'));});child.on('exit',code=>{clearTimeout(timer);code===0?resolve():reject(problem('DOCX could not be rendered. Import the matching PDF for preview.'));});});
  await copyFile(path.join(resultDir,'checked.pdf'),output);
 }finally{await rm(dir,{recursive:true,force:true});}
}

export class ResumeService {
 constructor({store,directory,model}){Object.assign(this,{store,directory,model});this.structureCache=new Map();this.postings=new PostingObservations({store});}
 assertPackageCurrent(pkg,profile=this.store.get('profile','main'),job=this.store.get('job',pkg?.jobId)){
  this.postings.assertPackage(pkg,job);
  if(!pkg||pkg.profileRevision!==profile?.updatedAt||pkg.profileHash&&pkg.profileHash!==hash(JSON.stringify(profile??null)))throw problem('The candidate profile changed after this resume was prepared. Prepare and review the document again.');
  const retained=normalize(pkg.text||''),sources=Array.isArray(pkg.sources)?pkg.sources:[],baseResumeIds=new Set([pkg.resumeId,...sources.map(source=>source.resumeId)].filter(Boolean));
  if([...baseResumeIds].some(id=>integrityHeld(this.store.get('resume',id))))throw problem('A retained resume source needs source/render review. Prepare from verified current evidence.');
  for(const source of sources){
   if(!source.factId)continue;const fact=this.store.get('fact',source.factId);
   if(!fact)throw problem('A supporting fact for this prepared resume is no longer available. Prepare and review the document again.');
   if(!usableFacts([fact],this.store.list('resume')).length)throw problem('A supporting fact has no current usable document source. Review the source/render mismatch or prepare from other verified evidence.');
   const quote=source.quote||fact.text;
   if(typeof quote==='string'&&quote.trim()&&retained.includes(normalize(quote))&&((fact.conflict||fact.suppressed)||normalize(fact.text)!==normalize(quote)))throw problem('This prepared resume retains a rejected, changed or unresolved supporting fact. Correct the evidence and prepare the document again.');
  }
  for(const fact of this.store.list('fact'))if((fact.conflict||fact.suppressed)&&fact.sources?.some(source=>baseResumeIds.has(source.resumeId))&&typeof fact.text==='string'&&fact.text.trim()&&retained.includes(normalize(fact.text)))throw problem('This prepared resume still contains a rejected or unresolved source fact. Correct the source or replace that exact passage before continuing.');
  return pkg;
 }
 async import(files){
  if(!Array.isArray(files)||!files.length||files.length>60)throw problem('Choose between 1 and 60 documents.');
  let total=0;const result={imported:0,duplicates:0,errors:[]};
  for(const f of files){try{
   const name=String(f.name||'').slice(0,200),ext=path.extname(name).toLowerCase();const mime={'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.txt':'text/plain','.md':'text/markdown'}[ext];
   if(!mime)throw problem('Use PDF, DOCX, Markdown or TXT.');
   if(typeof f.content!=='string'||f.content.length>17*1024*1024||!/^[-A-Za-z0-9+/=\r\n]*$/.test(f.content))throw problem('Invalid or oversized file.');
   const bytes=Buffer.from(f.content,'base64');total+=bytes.length;if(bytes.length>12*1024*1024||total>50*1024*1024)throw problem('Limit is 12 MB per file and 50 MB per batch.');
   if(mime==='application/pdf'&&!bytes.subarray(0,5).equals(Buffer.from('%PDF-')))throw problem('File is not a PDF.');
   const digest=hash(bytes),id=`resume-${digest.slice(0,24)}`;
   const duplicate=this.store.get('resume',id);if(duplicate){if(Boolean(duplicate.mega)!==Boolean(f.mega))throw problem('This exact document already has a different library role. Keep mega evidence separate from finished uploads.');result.duplicates++;continue;}
   const dir=path.join(this.directory,'resumes',id);await mkdir(dir,{recursive:true,mode:0o700});const originalPath=path.join(dir,'original'+ext);const temp=originalPath+'.partial';await writeFile(temp,bytes,{mode:0o600});await rename(temp,originalPath);
   const parsed=await extract(originalPath,mime);
   if(parsed.text.length<30)throw problem('No usable text found. Import a text-based PDF or an editable copy. Scanned PDFs need OCR first.');
   const doc={id,name,mime,hash:digest,originalPath,text:parsed.text,links:parsed.links||[],pages:parsed.pages||null,mega:Boolean(f.mega),createdAt:now(),previewPath:null,renderStatus:'pending'};
   if(mime.includes('wordprocessingml')||mime==='text/markdown')doc.structureContexts=resumeStructureContexts(doc,bytes);
   // Store original and extracted evidence even when preview rendering is unavailable.
   if(mime==='application/pdf'){doc.previewPath=originalPath;doc.renderStatus='ready';}
   else {const preview=path.join(dir,'preview.pdf');try{mime.includes('wordprocessingml')?await renderDocx(originalPath,preview):await renderText(doc.text,preview);const check=await extract(preview,'application/pdf');doc.previewPath=preview;doc.pages=check.pages;assertRenderedText(doc.text,check.text,{sourceMime:mime});doc.renderStatus='ready';}catch(error){doc.renderStatus=error.renderCode==='render_integrity_review'?'needs_review':error.code==='docx_resource_review'?'needs_resource_review':'needs_renderer';doc.renderCode=error.renderCode||error.code||'resume_review';doc.renderError=error.message;}}
   this.store.put('resume',doc);this.indexFacts(doc);result.imported++;
  }catch(e){result.errors.push({name:String(f?.name||'file'),message:e.message});}}
  return result;
 }
 indexFacts(resume){
  const lines=resume.text.split('\n').map(normalize).filter(l=>l.length>=18&&l.length<=1800);
  this.store.transaction(()=>{for(const text of lines){const context=resumePassageContext(resume,text);const id='fact-'+hash(context+'|'+normalize(text).toLowerCase()).slice(0,24);const old=this.store.get('fact',id);const sources=old?.sources||[];if(!sources.some(s=>s.resumeId===resume.id))sources.push({resumeId:resume.id,name:resume.name,mega:resume.mega,quote:text,context,contextLabel:resume.structureContexts?.labels?.[context]||context,scopeEvidence:resume.structureContexts?.scopeEvidence?.[context]||[]});this.store.put('fact',{...old,id,text,sources,conflict:old?.conflict||false});}
   // Numeric variants of the same claim are potential conflicts, not automatic precedence.
   const groups=new Map();for(const fact of this.store.list('fact')){const context=fact.sources[0]?.context;if(!context||!/\d/.test(fact.text))continue;const signature=context+'|'+normalize(fact.text.toLowerCase()).replace(/\d+(?:[.,]\d+)?/g,'#');const group=groups.get(signature)||[];group.push(fact);groups.set(signature,group);}
   for(const group of groups.values()){if(group.length<2||group.every(f=>f.confirmedAt))continue;for(const f of group)this.store.put('fact',{...f,conflict:true,conflictsWith:group.filter(x=>x.id!==f.id).map(x=>x.id)});const id='conflict-'+hash(group.map(f=>f.id).sort().join('|')).slice(0,24);if(!this.store.get('decision',id)||this.store.get('decision',id).state==='resolved')this.store.put('decision',{id,type:'fact_conflict',scope:'resume_library',state:'open',question:'Which version of this fact is correct?',reason:'Imported resumes contain different numbers or dates. Neither source takes precedence.',options:group.map(f=>f.text).concat(['Keep unresolved','Other']),factIds:group.map(f=>f.id),createdAt:now()});}
  });
 }
 async prepare(job,profile){
  const resumes=this.store.list('resume'),libraryFinished=resumes.filter(r=>!r.mega),finished=libraryFinished.filter(resume=>!integrityHeld(resume));if(!finished.length){if(libraryFinished.length)throw problem('Your finished sources need rendered-text review. Review the retained originals and previews, or import a matching verified PDF.');throw problem('Import at least one finished resume.','resume_missing');}
  const facts=usableFacts(this.store.list('fact'),resumes);
  const comparisonSnapshot=hash(JSON.stringify({resumes:this.store.list('resume'),facts:this.store.list('fact'),profile:this.store.get('profile','main')}));
  const context=reasoningContext(this.store,job);
  const assertContext=()=>{const current=this.store.get('job',job.id);if(current&&(current.revision!==job.revision||['manual','cancelled'].includes(current.state))||reasoningContext(this.store,current||job).contextHash!==context.contextHash)throw problem('The application, candidate or source evidence changed during comparison. Prepare this application again.','action_revoked');};
  const roleTerms=new Set(((job.posting?.text||job.description||job.title||'').toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g)||[]).filter(w=>!['the','and','for','with','you','are','our','will','that','this','have','from','work','your','intern','internship'].includes(w)));
  const relevance=r=>new Set((r.text.toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g)||[]).filter(w=>roleTerms.has(w))).size;
  const promising=new Set([...finished].sort((a,b)=>relevance(b)-relevance(a)).slice(0,8).map(r=>r.id));
  const structureCatalog=[];let structureChars=0;
  for(const resume of finished.filter(item=>promising.has(item.id)&&item.mime!=='application/pdf')){
   let catalog=this.structureCache.get(resume.hash);if(!catalog){try{catalog=resumeStructureCatalog(resume,await readOriginalResume(resume));}catch{catalog={resumeId:resume.id,sourceHash:resume.hash,supported:false,sections:[],reason:'Editable structure is unavailable; unchanged reuse remains subject to source verification.'};}this.structureCache.set(resume.hash,catalog);}
   const entry={...catalog,resumeId:resume.id};const size=JSON.stringify(entry).length;if(structureChars+size<=120000){structureCatalog.push(entry);structureChars+=size;}
  }
  assertContext();
  const data={job:{title:job.title,employer:job.employer,description:(job.posting?.text||job.description||job.postingText||'').slice(0,45000),requirements:job.posting?.requirements||job.requirements},profile,scopedAnswers:currentReasoningAnswers(job,context),resumes:finished.map(r=>({id:r.id,name:r.name,mime:r.mime,pages:r.pages,text:promising.has(r.id)?r.text.slice(0,14000):r.text.slice(0,1800),relevantPassages:r.text.split('\n').filter(line=>(line.toLowerCase().match(/[a-z][a-z0-9+#.]{2,}/g)||[]).some(w=>roleTerms.has(w))).slice(0,6).map(line=>line.slice(0,500)),fullTextIncluded:promising.has(r.id)})),facts:[...facts].sort((a,b)=>relevance({text:b.text+' '+b.sources.map(s=>s.context||'').join(' ')})-relevance({text:a.text+' '+a.sources.map(s=>s.context||'').join(' ')})).slice(0,1500).map(f=>({id:f.id,text:f.text,conflict:f.conflict,sources:[...new Map(f.sources.map(s=>[s.context,{resumeId:s.resumeId,context:s.context,contextLabel:s.contextLabel||s.context,scopeEvidence:s.scopeEvidence||[]}])).values()].slice(0,3)}))};
  data.structureCatalog=structureCatalog;
  const candidates=data.facts;data.facts=[];let inputChars=JSON.stringify(data).length;
  for(const fact of candidates){const length=JSON.stringify(fact).length+1;if(inputChars+length>650000)continue;data.facts.push(fact);inputChars+=length;}
  data.evidenceCoverage={libraryFactCount:facts.length,includedFactCount:data.facts.length,finishedResumeCount:finished.length,fullResumeCount:promising.size};
  if(JSON.stringify(data).length>700000)throw problem('Resume library is too large for one reasoning request. Import shorter application resumes.');
  const result=await this.model.reason(data);if(comparisonSnapshot!==hash(JSON.stringify({resumes:this.store.list('resume'),facts:this.store.list('fact'),profile:this.store.get('profile','main')})))throw problem('The candidate or resume library changed during comparison. Prepare this application again with the current sources.');assertContext();const chosen=finished.find(r=>r.id===result.chosenResumeId);if(!chosen)throw problem('Reasoning selected a document outside your finished resume library.');
  const requirements=result.requirements.map(r=>{const posting=normalize(job.posting?.text||job.description||job.postingText||'');if(r.kind!=='uncertain'&&(!r.quote||!posting.includes(normalize(r.quote))))throw problem('A stated job requirement has no matching posting quote.');return r;});
  if(result.questions.length){const questions=result.questions.map(q=>{const decision={jobId:job.id,type:'missing_fact',state:'open',question:q.question,reason:q.reason,options:q.options.concat(['None','Other']),createdAt:now()};const questionHash=reasoningQuestionHash(decision),baseId=`decision-${job.id}-reason-${context.contextHash.slice(0,24)}-${questionHash.slice(0,24)}`,previous=this.store.get('decision',baseId),id=previous&&previous.state!=='open'?`${baseId}-${randomUUID()}`:baseId;return {...decision,id,reasoningBinding:{...context,questionHash}};});assertContext();this.store.transaction(()=>{for(const decision of questions)if(!this.store.get('decision',decision.id))this.store.put('decision',decision);});throw problem('Resume preparation needs your answers. See Needs You.','needs_you');}
  return this.createPackage(job,chosen,{explanation:result.explanation,edits:result.edits,structureEdits:result.structureEdits||[],requirements,evidenceCoverage:data.evidenceCoverage});
 }
 async select(job,resumeId){const resume=this.store.get('resume',resumeId);if(!resume||resume.mega)throw problem('Choose a finished resume. The mega resume is evidence only.');return this.createPackage(job,resume,{explanation:'You selected this finished resume unchanged. Check role suitability and preview before approval.',edits:[],requirements:[]});}
 async createPackage(job,resume,{explanation,edits=[],structureEdits=[],requirements=[],evidenceCoverage=null}){
  if(integrityHeld(resume))throw problem('This source has a rendered-text mismatch. Review its retained original and preview, or import a matching verified PDF.');
  const candidate=this.store.get('profile','main');const person=s=>String(s||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().split(/\s+/).filter(Boolean);const name=person(candidate?.fullName);const header=new Set(person(resume.text.split('\n').filter(Boolean).slice(0,5).join(' ')));if(name.length&&(!header.has(name[0])||!header.has(name.at(-1))))throw problem('This resume header does not match the confirmed candidate name. Correct the profile or import the right candidate document.','resume_review');
  const sourceState=()=>hash(JSON.stringify({profile:this.store.get('profile','main'),facts:this.store.list('fact'),resume:this.store.get('resume',resume.id)})),preparationSnapshot=sourceState();
  const sourceBytes=await readOriginalResume(resume),structure=restructureResume(resume,sourceBytes,structureEdits),workingResume={...resume,hash:hash(structure.bytes),text:structure.text,links:structure.links};
  if(resume.mime.includes('wordprocessingml')||resume.mime==='text/markdown')workingResume.structureContexts=resumeStructureContexts(workingResume,structure.bytes);
  const facts=usableFacts(this.store.list('fact'),this.store.list('resume'));const text=validateEdits(workingResume,facts,edits),changes=[...structure.changes,...edits];
  const retainedConflict=this.store.list('fact').find(f=>(f.conflict||f.suppressed)&&f.sources.some(s=>s.resumeId===resume.id)&&normalize(text).includes(normalize(f.text)));
  if(retainedConflict)throw problem('The selected resume still contains an unresolved or rejected fact. Resolve the library conflict and import a corrected version, or replace that exact passage.','fact_conflict');
  if(changes.length&&resume.mime==='application/pdf')throw problem('PDF source layout cannot be edited safely. Choose unchanged reuse or import its editable DOCX/Markdown source.','editable_source_needed');
  const postingObservation=this.postings.record(job,job.posting,{adopt:true,reason:'manual_selection'}),postingBinding=this.postings.binding(job,postingObservation);
  const id='package-'+randomUUID(),dir=path.join(this.directory,'packages',id);await mkdir(dir,{recursive:true,mode:0o700});let finalPath,previewPath;
  if(!changes.length&&resume.mime==='application/pdf'){finalPath=path.join(dir,'resume.pdf');await writeFile(finalPath,sourceBytes,{mode:0o600});previewPath=finalPath;}
  else if(resume.mime.includes('wordprocessingml')){const docx=path.join(dir,'resume.docx');await writeFile(docx,edits.length?patchDocx(structure.bytes,edits):structure.bytes,{mode:0o600});finalPath=docx;previewPath=path.join(dir,'resume.pdf');await renderDocx(finalPath,previewPath);}
  else {finalPath=path.join(dir,'resume.pdf');await renderText(text,finalPath);previewPath=finalPath;}
  const parsed=await extract(previewPath,'application/pdf');
  const expectedLinks=workingResume.links||[];const missingLinks=expectedLinks.filter(url=>!(parsed.links||[]).includes(url));if(missingLinks.length)throw problem('Rendered document did not preserve every retained source link. Use the original PDF or correct the editable source.','resume_review');
  assertRenderedText(text,parsed.text,{sourceMime:resume.mime});
  if(parsed.pages>(resume.pages||2))throw problem('Prepared resume exceeds the original page count. Shorten the source or choose unchanged reuse.');
  const resumeControls=(job.posting?.documents||[]).filter(control=>/resume|curriculum\s+vitae|\bcv\b/i.test(`${control.label||''} ${control.name||''}`));
  const accepts=file=>resumeControls.every(control=>fileAccepts({accept:control.accept,name:path.basename(file),mime:file.endsWith('.docx')?'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'application/pdf'}));
  let editableFinalPath=null;
  if(!accepts(finalPath)){
   if(finalPath.endsWith('.docx')&&accepts(previewPath)){editableFinalPath=finalPath;finalPath=previewPath;explanation+=' The portal requires PDF, so the verified rendered PDF is the upload version. The editable DOCX is retained.';}
   else throw problem('The observed resume upload controls do not accept a supported common document format. Review the portal requirements before continuing.','resume_review');
  }
  const size=(await stat(finalPath)).size;if(size>12*1024*1024)throw problem('Final resume exceeds 12 MB.');
  const finalBytes=await readFile(finalPath);await readOriginalResume(resume);if(preparationSnapshot!==sourceState())throw problem('The candidate or source evidence changed during document preparation. Prepare this application again before approval.');
  const pkg={id,jobId:job.id,postingBinding,profileRevision:candidate?.updatedAt,profileHash:hash(JSON.stringify(candidate??null)),resumeId:resume.id,finalPath,previewPath,editableFinalPath,mime:finalPath.endsWith('.docx')?resume.mime:'application/pdf',hash:hash(finalBytes),text,explanation,evidenceCoverage,changes,structureProvenance:structure.provenance,requirements,sources:[{resumeId:resume.id,hash:resume.hash},...edits.flatMap(e=>e.factIds.map(factId=>({factId,quote:facts.find(fact=>fact.id===factId)?.text})))],verified:true,approved:!changes.length&&this.store.get('campaign','main')?.rules?.autoApproveUnchanged===true,verification:{text:true,candidateName:!!name.length,pages:parsed.pages,bytes:size,links:parsed.links||[],visualReview:'required'},createdAt:now()};this.assertPackageCurrent(pkg,undefined,this.store.get('job',job.id)||{...job,postingObservationId:postingObservation.id,latestPostingObservationId:postingObservation.id});this.store.put('package',pkg);this.store.event(job.id,'package_prepared',{packageId:id,resumeId:resume.id,hash:pkg.hash});return pkg;
 }
}
