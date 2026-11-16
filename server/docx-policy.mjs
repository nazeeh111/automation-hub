import path from 'node:path';
import {isIP} from 'node:net';
import {unzipSync} from 'fflate';
import {DOMParser} from '@xmldom/xmldom';
import {privateAddress} from './adapters.mjs';

const PACKAGE_RELATIONSHIPS='http://schemas.openxmlformats.org/package/2006/relationships';
const CONTENT_TYPES='http://schemas.openxmlformats.org/package/2006/content-types';
const HYPERLINKS=new Set(['http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink','http://purl.oclc.org/ooxml/officeDocument/relationships/hyperlink']);
const LIMIT=12*1024*1024;
function hold(message,reason='unverified_relationships'){
 return Object.assign(new Error(message+' Keep the original. Use a self-contained DOCX with ordinary embedded PNG/JPEG images, or import the intended finished PDF.'),{code:'docx_resource_review',status:409,hold:true,resourceReason:reason});
}
function invalid(){return hold('The DOCX resource relationships could not be verified safely.');}
function xmlDocument(bytes){
 if(bytes.length>1024*1024)throw hold('The DOCX relationship metadata exceeds the review limit.','relationship_limit');
 let encoding='utf-8';
 if(bytes[0]===0xff&&bytes[1]===0xfe||bytes[0]===0x3c&&bytes[1]===0)encoding='utf-16le';
 if(bytes[0]===0xfe&&bytes[1]===0xff||bytes[0]===0&&bytes[1]===0x3c)encoding='utf-16be';
 let text;try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes);}catch{throw invalid();}
 const declaration=text.match(/^\s*<\?xml\s[^?]*\bencoding\s*=\s*(['"])([^'"]+)\1/i)?.[2]?.toLowerCase();
 if(declaration&&!['utf-8','utf8','us-ascii','utf-16','utf-16le','utf-16be'].includes(declaration))throw invalid();
 if(declaration&&((encoding==='utf-8'&&declaration.startsWith('utf-16'))||(encoding!=='utf-8'&&!declaration.startsWith('utf-16'))))throw invalid();
 // Relationship metadata has no need for a DTD or application-defined entity.
 // Numeric and predefined XML entities are decoded by the parser below.
 if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text))throw invalid();
 let malformed=false,document;
 try{document=new DOMParser({errorHandler:{warning(){malformed=true;},error(){malformed=true;},fatalError(){malformed=true;}}}).parseFromString(text,'application/xml');}catch{throw invalid();}
 if(malformed||!document?.documentElement||document.doctype)throw invalid();
 return document;
}
function publicHyperlink(target){
 if(/[\u0000-\u001f\u007f]/.test(target))return false;
 let url;try{url=new URL(target);}catch{return false;}
 if(url.protocol==='mailto:')return Boolean(url.pathname&&!/%0[ad]/i.test(url.href)&&url.pathname.split(',').every(address=>/^[^\s@<>]+@[^\s@<>]+$/.test(address)));
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname)return false;
 const host=url.hostname.toLowerCase(),ip=isIP(host.replace(/^\[|\]$/g,''));
 return (ip||host.includes('.'))&&!host.endsWith('.')&&!['localhost','metadata.google.internal'].includes(host)&&!host.endsWith('.localhost')&&!host.endsWith('.local')&&(!ip||!privateAddress(host));
}
function sourcePart(relationshipPart){
 if(/^_rels\/\.rels$/i.test(relationshipPart))return '';
 const match=relationshipPart.match(/^(.*\/)?_rels\/([^/]+)\.rels$/i);
 if(!match)throw invalid();return (match[1]||'')+match[2];
}
function containedTarget(target,source,entries){
 if(target.startsWith('//')||target.includes('\\')||/[\u0000-\u001f\u007f]/.test(target)||/^[a-z][a-z0-9+.-]*:/i.test(target))return false;
 const part=target.split('#')[0];if(part.includes('?'))return false;
 let decoded;try{decoded=decodeURIComponent(part);}catch{return false;}
 if(decoded.includes('\\')||/[\u0000-\u001f\u007f]/.test(decoded)||/%[a-f0-9]{2}/i.test(decoded)||decoded.startsWith('//')||/^[a-z][a-z0-9+.-]*:/i.test(decoded))return false;
 const resolved=part===''?source:path.posix.normalize(decoded.startsWith('/')?decoded.slice(1):path.posix.join(path.posix.dirname(source),decoded));
 return resolved&&!resolved.endsWith('/')&&!resolved.startsWith('../')&&resolved!== '..'&&entries.has(resolved)?resolved:null;
}

function contentTypes(bytes,entries){
 const root=xmlDocument(bytes).documentElement;if(root.localName!=='Types'||root.namespaceURI!==CONTENT_TYPES)throw invalid();
 const defaults=new Map(),overrides=new Map();
 for(let node=root.firstChild;node;node=node.nextSibling){
  if(node.nodeType===8||node.nodeType===3&&!node.data.trim())continue;
  if(node.nodeType!==1||node.namespaceURI!==CONTENT_TYPES)throw invalid();
  const type=node.getAttribute('ContentType');if(!type||!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(type))throw invalid();
  if(node.localName==='Default'){const extension=node.getAttribute('Extension')?.toLowerCase();if(!extension||extension.includes('/')||defaults.has(extension))throw invalid();defaults.set(extension,type.toLowerCase());}
  else if(node.localName==='Override'){const name=node.getAttribute('PartName');if(!name?.startsWith('/'))throw invalid();const part=containedTarget(name,'',entries);if(!part||overrides.has(part))throw invalid();overrides.set(part,type.toLowerCase());}
  else throw invalid();
 }
 return name=>overrides.get(name)||defaults.get(path.posix.extname(name).slice(1).toLowerCase())||null;
}
function pngBytes(bytes){
 const signature=[137,80,78,71,13,10,26,10];if(bytes.length<45||!signature.every((value,index)=>bytes[index]===value))return false;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=8,first=true,image=false,chunks=0;
 while(offset+12<=bytes.length&&++chunks<=10000){
  const size=view.getUint32(offset),kind=String.fromCharCode(...bytes.subarray(offset+4,offset+8));if(size>bytes.length-offset-12||! /^[A-Za-z]{4}$/.test(kind))return false;
  if(first&&(kind!=='IHDR'||size!==13||!view.getUint32(offset+8)||!view.getUint32(offset+12)))return false;first=false;
  if(kind==='IDAT')image=true;
  if(kind==='IEND')return size===0&&image&&offset+12===bytes.length;
  offset+=size+12;
 }
 return false;
}
function jpegBytes(bytes){
 if(bytes.length<12||bytes[0]!==0xff||bytes[1]!==0xd8||bytes.at(-2)!==0xff||bytes.at(-1)!==0xd9)return false;
 const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);let offset=2,frame=false,segments=0;
 while(offset<bytes.length-2&&++segments<=10000){
  if(bytes[offset++]!==0xff)return false;while(bytes[offset]===0xff)offset++;const marker=bytes[offset++];
  if(marker===0xda)return frame;
  if(marker===0x01||marker>=0xd0&&marker<=0xd7)continue;
  if(offset+2>bytes.length||marker===0||marker===0xd8||marker===0xd9)return false;
  const size=view.getUint16(offset);if(size<2||size>bytes.length-offset)return false;
  if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){if(size<8||!view.getUint16(offset+3)||!view.getUint16(offset+5))return false;frame=true;}
  offset+=size;
 }
 return false;
}
function actualImageReferences(bytes){
 const main=new Set(['http://schemas.openxmlformats.org/wordprocessingml/2006/main','http://purl.oclc.org/ooxml/wordprocessingml/main']);
 const drawing=new Set(['http://schemas.openxmlformats.org/drawingml/2006/main','http://purl.oclc.org/ooxml/drawingml/main']);
 const relNamespaces=['http://schemas.openxmlformats.org/officeDocument/2006/relationships','http://purl.oclc.org/ooxml/officeDocument/relationships'];
 const references=new Set(),stack=[xmlDocument(bytes).documentElement];let elements=0;
 while(stack.length){const node=stack.pop();if(++elements>50000)throw hold('The DOCX resource markup exceeds the review limit.','document_limit');
  if(main.has(node.namespaceURI)&&node.localName==='altChunk'||node.namespaceURI==='urn:schemas-microsoft-com:office:office'&&node.localName==='OLEObject')throw hold('This DOCX contains imported HTML or an embedded object that needs review before rendering.','embedded_format');
  const blip=drawing.has(node.namespaceURI)&&node.localName==='blip'||node.namespaceURI==='http://schemas.microsoft.com/office/drawing/2016/SVG/main'&&node.localName==='svgBlip';
  const vml=node.namespaceURI==='urn:schemas-microsoft-com:vml'&&node.localName==='imagedata';
  if(blip||vml){let found=false;for(const namespace of relNamespaces)for(const attribute of vml?['id']:['embed','link']){const value=node.getAttributeNS(namespace,attribute);if(value){references.add(value);found=true;}}
   if(vml&&!found)throw hold('This DOCX uses an image reference that cannot be verified as a contained raster image.','embedded_image_format');
  }
  for(let child=node.firstChild;child;child=child.nextSibling)if(child.nodeType===1)stack.push(child);
 }
 return references;
}

// This checks OPC relationships before LibreOffice receives the exact bytes.
// It is not a general macro/field/embedded-format execution sandbox.
export function assertDocxResources(bytes){
 if(!(bytes instanceof Uint8Array)||bytes.length>LIMIT)throw hold('The DOCX exceeds the document review limit.','document_limit');
 let expanded=0,metadataBytes=0,files;const entries=new Set();
 try{files=unzipSync(bytes,{filter:entry=>{
  const name=entry.name;
  const plain=name.replace(/\/$/,'');
  if(entries.size>=4096||!plain||name.length>1024||name.includes('\\')||name.includes('\0')||name.startsWith('/')||plain==='..'||plain.startsWith('../')||/^[a-z][a-z0-9+.-]*:/i.test(plain)||path.posix.normalize(plain)!==plain||name==='__proto__'||entries.has(name))throw invalid();
  entries.add(name);expanded+=entry.originalSize;
  if(expanded>60*1024*1024||entry.originalSize>20*1024*1024)throw hold('The DOCX expanded content exceeds the document review limit.','document_limit');
  if(/\.rels$/i.test(name)||name==='[Content_Types].xml'){metadataBytes+=entry.originalSize;if(metadataBytes>4*1024*1024)throw hold('The DOCX relationship metadata exceeds the review limit.','relationship_limit');return true;}
  return false;
 }});}catch(error){if(error.code==='docx_resource_review')throw error;throw invalid();}
 if(!entries.has('[Content_Types].xml')||!entries.has('_rels/.rels'))throw invalid();
 const typeFor=contentTypes(files['[Content_Types].xml'],entries),images=new Set(),hyperlinks=[];let relationships=0;
 for(const name of entries){const type=typeFor(name)||'';
  if(type.startsWith('image/')||/\.(?:png|jpe?g|svgz?|gif|bmp|tiff?|webp|wmf|emf|pict|avif|heic)$/i.test(name))images.add(name);
  if(/(?:^|\/)embeddings\//i.test(name)||/html|oleobject|vnd\.openxmlformats-officedocument\.(?:spreadsheetml|presentationml)/i.test(type))throw hold('This DOCX contains richer embedded document content that needs review before rendering.','embedded_format');
 }
 const sources=new Set(Object.keys(files).filter(name=>/\.rels$/i.test(name)).map(sourcePart).filter(Boolean));
 const xmlParts=new Set([...entries].filter(name=>name!=='[Content_Types].xml'&&!/\.rels$/i.test(name)&&(/\.(?:xml|vml)$/i.test(name)||(typeFor(name)||'').endsWith('+xml')||typeFor(name)==='application/xml'||sources.has(name))));
 let markupBytes=0,markup;try{markup=unzipSync(bytes,{filter:entry=>{if(!xmlParts.has(entry.name))return false;markupBytes+=entry.originalSize;if(markupBytes>8*1024*1024)throw hold('The DOCX resource markup exceeds the review limit.','document_limit');return true;}});}catch(error){if(error.code==='docx_resource_review')throw error;throw invalid();}
 const imageReferences=new Map();for(const [name,data] of Object.entries(markup))imageReferences.set(name,actualImageReferences(data));
 for(const [name,data] of Object.entries(files)){
  if(name==='[Content_Types].xml')continue;
  const source=sourcePart(name);if(source&&!entries.has(source))throw invalid();
  const root=xmlDocument(data).documentElement;
  if(root.localName!=='Relationships'||root.namespaceURI!==PACKAGE_RELATIONSHIPS)throw invalid();
  const ids=new Set();
  for(let node=root.firstChild;node;node=node.nextSibling){
   if(node.nodeType===8||node.nodeType===3&&!node.data.trim())continue;
   if(node.nodeType!==1||node.localName!=='Relationship'||node.namespaceURI!==PACKAGE_RELATIONSHIPS)throw invalid();
   if(++relationships>10000)throw hold('The DOCX has too many resource relationships.','relationship_limit');
   const id=node.getAttribute('Id'),type=node.getAttribute('Type'),target=node.getAttribute('Target'),mode=node.getAttribute('TargetMode');
   if(!id||ids.has(id)||!type||!target||mode&&!['Internal','External'].includes(mode))throw invalid();ids.add(id);
   for(let child=node.firstChild;child;child=child.nextSibling)if(!(child.nodeType===8||child.nodeType===3&&!child.data.trim()))throw invalid();
   if(imageReferences.get(source)?.has(id)){
    const image=containedTarget(target,source,entries);if(mode==='External'||!image)throw hold('This DOCX uses an external image. Preview and application preparation are paused before rendering.','external_resource');
    images.add(image);
   }
   if(HYPERLINKS.has(type)){
    if(publicHyperlink(target)){hyperlinks.push(target);continue;}
    if(mode!=='External'&&containedTarget(target,source,entries))continue;
    throw hold('This DOCX has a hyperlink outside supported public web or email destinations.','unsupported_hyperlink');
   }
   const part=containedTarget(target,source,entries);
   if(mode==='External'||!part){
    const kind=type.endsWith('/image')?'image':type.endsWith('/attachedTemplate')?'template':type.endsWith('/oleObject')?'linked object':'resource';
    throw hold(`This DOCX uses an external ${kind}. Preview and application preparation are paused before rendering.`,'external_resource');
   }
   if(/\/(?:afchunk|oleobject|package)$/i.test(type))throw hold('This DOCX imports HTML or contains a richer embedded object that needs review before rendering.','embedded_format');
   if(/\/(?:image|thumbnail)$/i.test(type))images.add(part);
  }
  for(const id of imageReferences.get(source)||[])if(!ids.has(id))throw hold('This DOCX has an unresolved image reference that needs review before rendering.','embedded_image_format');
 }
 let assets;try{assets=unzipSync(bytes,{filter:entry=>images.has(entry.name)});}catch{throw invalid();}
 for(const name of images){const data=assets[name],type=typeFor(name),extension=path.posix.extname(name).toLowerCase();
  const ordinary=data&&(type==='image/png'&&extension==='.png'&&pngBytes(data)||type==='image/jpeg'&&['.jpg','.jpeg'].includes(extension)&&jpegBytes(data));
  if(!ordinary)throw hold('This DOCX has an unsupported or mismatched embedded image format. Its image bytes need review before rendering.','embedded_image_format');
 }
 return {policy:'self_contained_relationships_and_raster_images',relationships,images:images.size,hyperlinks:[...new Set(hyperlinks)]};
}
