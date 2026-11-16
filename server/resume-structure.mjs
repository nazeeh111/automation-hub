import {createHash} from 'node:crypto';
import {open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {unzipSync,zipSync,strFromU8,strToU8} from 'fflate';

const hash=value=>createHash('sha256').update(value).digest('hex');
const norm=value=>String(value).normalize('NFKC').replace(/\s+/g,' ').trim();
const problem=message=>Object.assign(new Error(message),{code:'resume_review'});
const decode=value=>value.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&amp;/g,'&');
const sectionKind=title=>/^(?:technical |selected |engineering )?projects$/i.test(title)?'projects':/^(?:work |professional )?experience$/i.test(title)?'experience':/^research experience$/i.test(title)?'research_experience':null;
const sectionBoundary=title=>Boolean(sectionKind(title))||/^(?:education|skills|technical skills|summary|research|publications|awards|certifications|activities|leadership|volunteering|interests)$/i.test(title);
const urls=text=>[...new Set(String(text).match(/(?:https?:\/\/|mailto:)[^\s<>"')\]]+/g)||[])];

export async function readOriginalResume(resume){
 let file;try{file=await open(resume.originalPath,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch{throw problem('The retained original resume is unavailable or its file boundary changed. Import a fresh source.');}
 try{
  const info=await file.stat();if(!info.isFile()||info.size>12*1024*1024)throw problem('The original resume is missing or exceeds the document limit.');
  const buffer=Buffer.alloc(Math.min(info.size+1,12*1024*1024+1));let size=0;
  while(size<buffer.length){const part=await file.read(buffer,size,buffer.length-size,size);if(!part.bytesRead)break;size+=part.bytesRead;}
  if(size!==info.size||(await file.stat()).size!==info.size)throw problem('The original resume changed during preparation. Import a fresh original.');
  const bytes=buffer.subarray(0,size);if(hash(bytes)!==resume.hash)throw problem('The retained original resume changed after import. Import and review the current source.');
  return bytes;
 }finally{await file.close();}
}

function paragraphText(xml){return [...xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(?:tab|br)\b[^>]*\/>/g)].map(match=>match[1]===undefined?' ':decode(match[1])).join('');}
function unpack(bytes){let size=0;const files=unzipSync(new Uint8Array(bytes),{filter:entry=>{size+=entry.originalSize;if(size>60*1024*1024||entry.originalSize>20*1024*1024)throw problem('The DOCX structure exceeds safe document limits.');return true;}});if(!files['word/document.xml'])throw problem('The DOCX main document is missing.');return files;}
function unorderedParagraph(raw,text,files){
 if(!/<w:numPr\b/.test(raw))return /^\s*[-*•]\s+/.test(text);
 const id=raw.match(/<w:numId\b[^>]*w:val="(\d+)"/)?.[1];if(!id)return false;
 const xml=strFromU8(files['word/numbering.xml']||new Uint8Array()),number=xml.match(new RegExp(`<w:num\\b[^>]*w:numId="${id}"[^>]*>[\\s\\S]*?<\\/w:num>`))?.[0];
 if(!number||/<w:lvlOverride\b/.test(number))return false;
 const abstract=number.match(/<w:abstractNumId\b[^>]*w:val="(\d+)"/)?.[1];if(!abstract)return false;
 const definition=xml.match(new RegExp(`<w:abstractNum\\b[^>]*w:abstractNumId="${abstract}"[^>]*>[\\s\\S]*?<\\/w:abstractNum>`))?.[0],level=definition?.match(/<w:lvl\b[^>]*w:ilvl="0"[^>]*>[\s\S]*?<\/w:lvl>/)?.[0];
 return Boolean(level&&/<w:numFmt\b[^>]*w:val="bullet"/.test(level));
}
function rowsFor(resume,bytes){
 if(resume.mime==='application/pdf')return {reason:'PDF originals can be reused unchanged; import their editable source for structural changes.'};
 if(resume.mime.includes('wordprocessingml')){
  const files=unpack(bytes),xml=strFromU8(files['word/document.xml']);
  if(/<w:(?:tbl|txbxContent|sdt|altChunk)\b/.test(xml))return {reason:'This DOCX uses a table, text box or content control. Its structural layout needs manual editing.'};
  const rows=[...xml.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(match=>{
   const raw=match[0],text=paragraphText(raw),style=raw.match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1]||'';
   const headingLevel=Number(style.match(/^Heading([1-6])$/i)?.[1]||0)||((raw.match(/<w:outlineLvl\b[^>]*w:val="([0-5])"/)?.[1]!==undefined)?Number(raw.match(/<w:outlineLvl\b[^>]*w:val="([0-5])"/)[1])+1:0);
   return {raw,text,start:match.index,end:match.index+raw.length,section:sectionBoundary(norm(text)),heading:headingLevel>0,headingLevel,listLevel:Number(raw.match(/<w:ilvl\b[^>]*w:val="(\d+)"/)?.[1]||0),listAtomic:!unorderedParagraph(raw,text,files),bullet:/<w:numPr\b/.test(raw)||/^List(?:Bullet|Paragraph)/i.test(style)||/^\s*[-*•]\s+/.test(text)};
  });return {format:'docx',files,xml,rows};
 }
 const text=bytes.toString('utf8'),lines=text.match(/[^\n]*(?:\n|$)/g).filter(Boolean);let at=0;
 const rows=lines.map(raw=>{const start=at;at+=raw.length;const line=raw.replace(/\r?\n$/,'');const headingLevel=line.match(/^(#{3,6})\s+/)?.[1].length||0;return {raw,text:line,start,end:at,section:/^##\s+/.test(line),heading:headingLevel>0,headingLevel,listLevel:(line.match(/^\s+(?=[-*•]\s)/)?.[0]||'').length,bullet:/^\s*[-*•]\s+/.test(line)};});
 return {format:'markdown',text,rows};
}
function analyze(resume,bytes){
 const parsed=rowsFor(resume,bytes);if(parsed.reason)return {...parsed,sections:[]};
 const sections=[];
 for(let i=0;i<parsed.rows.length;i++){
  const row=parsed.rows[i],title=norm(row.text.replace(/^#+\s*/,'')),kind=row.section&&sectionKind(title);if(!kind)continue;
  let end=i+1;while(end<parsed.rows.length&&!parsed.rows[end].section)end++;
  const body=parsed.rows.slice(i+1,end),projectLevel=Math.min(...body.filter(item=>item.heading).map(item=>item.headingLevel)),first=body.findIndex(item=>item.heading&&item.headingLevel===projectLevel);
  if(first<0||body.slice(0,first).some(item=>norm(item.text)))continue;
  if(parsed.format==='docx'&&body.some(item=>/<w:(?:sectPr|drawing|object|fldChar|bookmarkStart|bookmarkEnd|commentRangeStart|commentRangeEnd)\b/.test(item.raw)))continue;
  const blocks=[];let block;
  for(const [index,item]of body.entries()){
   const projectHeading=item.heading&&item.headingLevel===projectLevel;
   if(projectHeading){block={id:'block-'+hash(resume.hash+'|'+i+'|'+index+'|'+item.text).slice(0,20),title:norm(item.text.replace(/^#+\s*/,'')),items:[]};blocks.push(block);}
   if(block)block.items.push({...item,id:'item-'+hash(resume.hash+'|'+item.start+'|'+item.raw).slice(0,20),kind:projectHeading?'heading':item.bullet?'bullet':'fixed'});
  }
  if(blocks.length<1||blocks.length>20)continue;
  sections.push({id:'section-'+hash(resume.hash+'|'+i+'|'+title).slice(0,20),title,kind,start:body[first].start,end:end<parsed.rows.length?parsed.rows[end].start:(parsed.format==='docx'?parsed.rows.at(-1).end:parsed.text.length),blocks});
 }
 return {...parsed,sections};
}
function canSelectBullets(block){const first=block.items.findIndex(item=>item.kind==='bullet'),last=block.items.findLastIndex(item=>item.kind==='bullet');return first<0||block.items.slice(first,last+1).every(item=>item.kind==='bullet'&&!item.listLevel&&!item.listAtomic);}
function publicSections(sections){return sections.map(section=>({id:section.id,title:section.title,kind:section.kind,blocks:section.blocks.map(block=>({id:block.id,title:block.title,bulletSelectionSupported:canSelectBullets(block),items:block.items.filter(item=>norm(item.text)).map(item=>({id:item.id,kind:item.kind,text:item.text})),bulletIds:block.items.filter(item=>item.kind==='bullet').map(item=>item.id)}))}));}
export function resumeStructureCatalog(resume,bytes){
 const parsed=analyze(resume,bytes);return {resumeId:resume.id,sourceHash:resume.hash,supported:Boolean(parsed.sections.length),reason:parsed.reason||(!parsed.sections.length?'No unambiguous editable project or experience blocks were found.':null),sections:publicSections(parsed.sections)};
}
// Native headings establish project identity. Metadata/phase labels and nested
// parents qualify that identity; their date alone can never become its name.
export function resumeStructureContexts(resume,bytes){
 if(hash(bytes)!==resume.hash)throw problem('The structure context source does not match its imported hash.');
 const parsed=analyze(resume,bytes),passages=new Map(),evidence=new Map(),labels=new Map();
 const key=text=>norm(text).toLowerCase(),scopeText=text=>norm(text.replace(/^#+\s*/,'').replace(/^\s*[-*•]\s+/,''));
 const add=(item,section,block,scope)=>{
  const text=key(item.text);if(!text)return;
  const parts=scope.map(scopeText).filter(Boolean),title=key(block.title);
  const context=parts.join('\n').length>4000||parts.length>32?null:[section.kind,...(parts.length?['scope:'+hash(parts.map(key).join('\n')).slice(0,20)]:[]),title].join('|');
  if(!passages.has(text))passages.set(text,context);else if(passages.get(text)!==context)passages.set(text,null);
  if(context){evidence.set(context,parts);labels.set(context,[block.title,...parts].join(' / '));}
 };
 for(const section of parsed.sections)for(const block of section.blocks){
  const first=block.items.findIndex(item=>item.kind==='bullet'),prefix=block.items.slice(1,first<0?undefined:first).filter(item=>item.kind==='fixed'&&norm(item.text));
  const phaseStart=prefix.findIndex(item=>item.headingLevel>0||/\b(?:phase|stage)\b/i.test(item.text));
  const initial=prefix.slice(0,phaseStart<0?undefined:phaseStart).map(item=>item.text);
  let phase=phaseStart<0?[]:prefix.slice(phaseStart).map(item=>item.text),seenBullet=false,parents=[];add(block.items[0],section,block,initial);
  for(let i=1;i<block.items.length;){const item=block.items[i];
   if(item.kind==='fixed'){
    const run=[];while(i<block.items.length&&block.items[i].kind==='fixed')run.push(block.items[i++]);
    if(seenBullet){phase=run.filter(part=>norm(part.text)).map(part=>part.text);parents=[];}
    for(const part of run)add(part,section,block,[...initial,...phase]);
   }else{
    const ancestors=parents.filter(parent=>parent.level<item.listLevel);
    add(item,section,block,[...initial,...phase,...ancestors.map(parent=>parent.text)]);
    parents=[...ancestors,{level:item.listLevel,text:item.text}];seenBullet=true;i++;
   }
  }
 }
 return {version:1,sourceHash:resume.hash,textHash:hash(resume.text),passages:Object.fromEntries(passages),scopeEvidence:Object.fromEntries(evidence),labels:Object.fromEntries(labels)};
}
export function restructureResume(resume,bytes,operations=[]){
 if(!Array.isArray(operations)||operations.length>4)throw problem('Resume structural changes exceed the review limit.');
 if(!operations.length)return {bytes,text:resume.text,links:resume.links||[],changes:[],provenance:[]};
 const parsed=analyze(resume,bytes);if(!parsed.sections.length)throw problem(parsed.reason||'This resume does not have supported editable blocks.');
 const seen=new Set(),replacements=[],changes=[],provenance=[];
 for(const operation of operations){
  const section=parsed.sections.find(item=>item.id===operation.sectionId);if(!section||seen.has(section.id))throw problem('A structural change does not match one unique source section.');seen.add(section.id);
  if(!Array.isArray(operation.blocks)||!operation.blocks.length||operation.blocks.length>section.blocks.length)throw problem('Choose at least one intact source project or experience block.');
  const selected=[],blockSeen=new Set();
  for(const selection of operation.blocks){
   const block=section.blocks.find(item=>item.id===selection.id);if(!block||blockSeen.has(block.id))throw problem('A selected block does not belong to this source section.');blockSeen.add(block.id);
   const bullets=block.items.filter(item=>item.kind==='bullet');if(!Array.isArray(selection.bulletIds)||new Set(selection.bulletIds).size!==selection.bulletIds.length||selection.bulletIds.some(id=>!bullets.some(item=>item.id===id)))throw problem('Selected bullets must come from their original project or experience.');
   if(bullets.length&&!selection.bulletIds.length)throw problem('Keep at least one supported bullet in a selected project, or omit that whole block.');
   const intact=selection.bulletIds.length===bullets.length&&selection.bulletIds.every((id,index)=>id===bullets[index].id);
   if(!intact&&!canSelectBullets(block))throw problem('This block interleaves dates, phase labels, nested lists or other fixed context with bullets. Move the intact block, or edit its internal structure manually.');
   if(intact){selected.push({block,items:block.items});continue;}
   const ordered=selection.bulletIds.map(id=>bullets.find(item=>item.id===id));let inserted=false;
   const items=block.items.flatMap(item=>{if(item.kind!=='bullet')return [item];if(inserted)return [];inserted=true;return ordered;});
   selected.push({block,items});
  }
  const raw=selected.flatMap(item=>item.items).map(item=>item.raw).join('');
  const original=(parsed.format==='docx'?parsed.xml:parsed.text).slice(section.start,section.end);
  if(raw!==original){replacements.push({start:section.start,end:section.end,raw});changes.push(`${section.title}: retained source blocks ${selected.map(item=>item.block.title).join(' → ')}; selected ${selected.reduce((n,item)=>n+item.items.filter(part=>part.kind==='bullet').length,0)} original bullets. Dates, headings and other retained block details stay unchanged.`);provenance.push({sectionId:section.id,sourceResumeId:resume.id,sourceHash:resume.hash,blocks:selected.map(item=>({id:item.block.id,bulletIds:item.items.filter(part=>part.kind==='bullet').map(part=>part.id)}))});}
 }
 let content=parsed.format==='docx'?parsed.xml:parsed.text;for(const change of replacements.sort((a,b)=>b.start-a.start))content=content.slice(0,change.start)+change.raw+content.slice(change.end);
 if(parsed.format==='docx'){
  parsed.files['word/document.xml']=strToU8(content);const refs=new Set([...content.matchAll(/<w:hyperlink\b[^>]*r:id="([^"]+)"/g)].map(match=>match[1]));
  const relationships=strFromU8(parsed.files['word/_rels/document.xml.rels']||new Uint8Array());const links=[...relationships.matchAll(/<Relationship\b[^>]*>/g)].map(match=>match[0]).filter(raw=>refs.has(raw.match(/\bId="([^"]+)"/)?.[1])&&/Type="[^"]*hyperlink"/.test(raw)).map(raw=>decode(raw.match(/\bTarget="([^"]+)"/)?.[1]||'')).filter(url=>/^(?:https?:|mailto:)/i.test(url));
  const text=[...content.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)].map(match=>paragraphText(match[0])).join('\n');return {bytes:Buffer.from(zipSync(parsed.files)),text,links:[...new Set(links)],changes,provenance};
 }
 return {bytes:Buffer.from(content),text:content,links:urls(content),changes,provenance};
}
