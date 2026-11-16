import path from 'node:path';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';

export const NODE_LICENSE_MAX_BYTES=2*1024*1024;
const message='Node license preflight failed. Set HUB_NODE_LICENSE to the absolute regular LICENSE file from the matching self-contained Node.js distribution. No license is downloaded or substituted.';
const failure=()=>Object.assign(new Error(message),{code:'NODE_LICENSE_UNAVAILABLE'});

// Capture the complete validated bytes before the native build writes anything.
// An explicit override is never replaced by an automatic fallback.
export async function readNodeLicense({executable=process.execPath,override}={}){
 if(typeof executable!=='string'||!path.isAbsolute(executable))throw failure();
 const selected=override===undefined?path.resolve(path.dirname(executable),'..','LICENSE'):override;
 if(typeof selected!=='string'||!path.isAbsolute(selected)||selected.includes('\0'))throw failure();
 let file;
 try{
  file=await open(selected,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const before=await file.stat();
  if(!before.isFile()||before.nlink!==1||before.size<1||before.size>NODE_LICENSE_MAX_BYTES)throw failure();
  const buffer=Buffer.alloc(NODE_LICENSE_MAX_BYTES+1);let length=0;
  while(length<buffer.length){const {bytesRead}=await file.read(buffer,length,buffer.length-length,null);if(!bytesRead)break;length+=bytesRead;}
  const after=await file.stat();
  if(!after.isFile()||after.nlink!==1||before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||length!==before.size||length>NODE_LICENSE_MAX_BYTES)throw failure();
  const bytes=buffer.subarray(0,length);
  if(bytes.includes(0)||!/^Node\.js is licensed for use as follows:\s/.test(bytes.toString('utf8')))throw failure();
  return bytes;
 }catch{throw failure();}
 finally{await file?.close();}
}
