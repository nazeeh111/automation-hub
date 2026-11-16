import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {mkdir,lstat,realpath,chmod,open,unlink,rename,link,readlink,symlink,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';

const APP='personal-automation-hub-local-launch',LIMIT=1024,TIMEOUT=1000;
const uid=()=>{if(typeof process.getuid!=='function')throw fault('Private local launch requires a Unix user boundary.','UNSUPPORTED_PLATFORM');if(typeof process.geteuid==='function'&&process.geteuid()!==process.getuid())throw fault('Elevated user contexts cannot open this private hub.','LOCAL_LAUNCH_OWNER');return process.getuid();};
const fault=(message,code='LOCAL_LAUNCH_REFUSED')=>Object.assign(new Error(message),{code});
const missing=error=>error.code==='ENOENT';
function owned(stat,{socket=false,file=false}={}){if(stat.isSymbolicLink()||stat.uid!==uid())throw fault('Private hub launch path has a different owner or is a symbolic link.','LOCAL_LAUNCH_OWNER');if(socket&&!stat.isSocket()||file&&!stat.isFile()||!socket&&!file&&!stat.isDirectory())throw fault('Private hub launch path has an unexpected file type.','LOCAL_LAUNCH_PATH');const expected=socket||file?0o600:0o700;if((stat.mode&0o7777)!==expected)throw fault('Private hub launch permissions are unsafe. Restore the documented private modes.','LOCAL_LAUNCH_MODE');return stat;}
async function directoryPath(directory,{create=false}={}){if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.length>4096||/[\x00-\x1f\x7f]/.test(directory))throw fault('Use an absolute private application data directory.','HUB_DATA_DIRECTORY');if(create)await mkdir(directory,{recursive:true,mode:0o700});owned(await lstat(directory));const resolved=await realpath(directory);if(Buffer.byteLength(path.join(resolved,'control.sock'))>100)throw fault('Private hub launch socket path is too long for this platform.','LOCAL_LAUNCH_PATH');return resolved;}
async function ownerManifest(directory,stat){const file=path.join(directory,'control-owner.json');const descriptor=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);let info,raw;try{info=owned(await descriptor.stat(),{file:true});const bytes=Buffer.alloc(LIMIT+1);const result=await descriptor.read(bytes,0,bytes.length,0);raw=bytes.subarray(0,result.bytesRead);}finally{await descriptor.close();}if(raw.length>LIMIT)throw fault('Private hub launch owner record is invalid.');let owner;try{owner=JSON.parse(raw)}catch{throw fault('Private hub launch owner record is invalid.');}if(owner.application!==APP||owner.version!==1||owner.uid!==uid()||!Number.isInteger(owner.pid)||owner.pid<1||stat&&(owner.socketDevice!==String(stat.dev)||owner.socketInode!==String(stat.ino)))throw fault('This socket is not an identified hub control socket.','LOCAL_LAUNCH_OWNER');return {owner,info};}
async function removeManifest(directory,expected,name='control-owner.json'){const file=path.join(directory,name),current=owned(await lstat(file),{file:true});if(current.dev!==expected.dev||current.ino!==expected.ino)throw fault('The private launch owner record changed during recovery.','LOCAL_LAUNCH_OWNER');await unlink(file);}
async function publishManifest(directory,record){
 const name='.control-owner-'+randomUUID()+'.json',staged=path.join(directory,name),file=await open(staged,'wx',0o600);let info;
 try{
  info=owned(await file.stat(),{file:true});await file.writeFile(JSON.stringify(record));await file.sync();
  const current=owned(await lstat(staged),{file:true});if(current.dev!==info.dev||current.ino!==info.ino)throw fault('The private launch owner record changed before publication.','LOCAL_LAUNCH_OWNER');
  // Publish complete bytes atomically without replacing any newer owner path.
  await link(staged,path.join(directory,'control-owner.json'));return info;
 }finally{await file.close();if(info)await removeManifest(directory,info,name);}
}
function alive(pid){try{process.kill(pid,0);return true}catch(error){if(error.code==='ESRCH')return false;throw fault('Native process ownership could not be verified.','LOCAL_LAUNCH_DENIED');}}
async function connect(socketPath){return new Promise((resolve,reject)=>{const socket=net.createConnection({path:socketPath});const timer=setTimeout(()=>{socket.destroy();reject(fault('Private hub launch connection timed out.','LOCAL_LAUNCH_TIMEOUT'));},TIMEOUT);socket.once('connect',()=>{clearTimeout(timer);resolve(socket)});socket.once('error',error=>{clearTimeout(timer);socket.destroy();reject(error)});});}
export function validateLaunchUrl(raw){let url;try{url=new URL(raw)}catch{throw fault('The running hub returned an invalid private launch response.','LOCAL_LAUNCH_PROTOCOL');}if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||Number(url.port)<1||Number(url.port)>65535||url.username||url.password||url.pathname!=='/auth'||url.hash||[...url.searchParams.keys()].length!==1||!url.searchParams.has('ticket')||!/^[a-f0-9]{64}$/.test(url.searchParams.get('ticket')))throw fault('The running hub returned an invalid private launch destination.','LOCAL_LAUNCH_PROTOCOL');return url.toString();}
export async function nativeOpen(url){return new Promise((resolve,reject)=>{const child=spawn(process.platform==='darwin'?'open':'xdg-open',[url],{stdio:'ignore'});child.once('error',error=>reject(fault('Native browser opening was denied or unavailable.',error.code||'NATIVE_OPEN_FAILED')));child.once('exit',code=>code===0?resolve():reject(fault('Native browser opening failed.','NATIVE_OPEN_FAILED')));});}

export class LocalLaunchServer {
 constructor({directory,issueLaunchUrl,shutdown}={}){if(typeof issueLaunchUrl!=='function')throw fault('A private launch callback is required.');this.directory=directory;this.issueLaunchUrl=issueLaunchUrl;this.shutdown=shutdown;this.connections=new Set();this.closing=false;}
 async start({leaseAcquired=false}={}){if(this.server)throw fault('Private launch control is already running.');this.directory=await directoryPath(this.directory,{create:true});this.socketPath=path.join(this.directory,'control.sock');this.manifestPath=path.join(this.directory,'control-owner.json');
  let existing;try{existing=owned(await lstat(this.socketPath),{socket:true})}catch(error){if(!missing(error))throw error;}
  if(existing){const {owner,info}=await ownerManifest(this.directory,existing);let client;try{client=await connect(this.socketPath)}catch(error){if(error.code!=='ECONNREFUSED'&&error.code!=='ENOENT')throw error;if(!leaseAcquired)throw fault('Acquire the hub worker lease before recovering its stale launch socket.','LOCAL_LAUNCH_LEASE');if(alive(owner.pid))throw fault('The socket owner is still running. Stop that hub before recovery.','LOCAL_LAUNCH_BUSY');const current=owned(await lstat(this.socketPath),{socket:true});if(current.dev!==existing.dev||current.ino!==existing.ino)throw fault('The launch socket changed during recovery.','LOCAL_LAUNCH_OWNER');await unlink(this.socketPath);await removeManifest(this.directory,info);}
   if(client){client.destroy();throw fault('Another private hub launch server is already running.','EADDRINUSE');}
  }else{let record;try{record=await ownerManifest(this.directory)}catch(error){if(!missing(error))throw error;}if(record){if(!leaseAcquired||alive(record.owner.pid))throw fault('The previous hub control owner must be stopped before recovery.','LOCAL_LAUNCH_BUSY');await removeManifest(this.directory,record.info);}}
  this.server=net.createServer(socket=>this.handle(socket));this.server.maxConnections=16;
  try{await new Promise((resolve,reject)=>{
    this.server.once('error',reject);
    // Unix listen binds synchronously. Create the socket private from its first
    // observation, before the listening callback and asynchronous chmod run.
    // No await may occur while the process-wide creation mask is changed.
    const mask=process.umask(0o177);
    try{this.server.listen(this.socketPath,resolve)}finally{process.umask(mask)}
   });await chmod(this.socketPath,0o600);this.socketStat=owned(await lstat(this.socketPath),{socket:true});const record={application:APP,version:1,uid:uid(),pid:process.pid,socketDevice:String(this.socketStat.dev),socketInode:String(this.socketStat.ino)};this.manifestStat=await publishManifest(this.directory,record);this.server.on('error',()=>{});return this;
  }catch(error){if(this.server?.listening)await new Promise(resolve=>this.server.close(resolve));this.server=null;throw error;}
 }
 handle(socket){
  this.connections.add(socket);let input=Buffer.alloc(0),handled=false;
  const timer=setTimeout(()=>socket.destroy(),TIMEOUT);timer.unref?.();
  socket.on('error',()=>{});socket.on('close',()=>{clearTimeout(timer);this.connections.delete(socket)});
  socket.on('data',async chunk=>{
   if(handled)return;
   if(input.length+chunk.length>LIMIT){handled=true;socket.end('{"ok":false,"error":"request_too_large"}\n');return;}
   input=Buffer.concat([input,chunk]);const newline=input.indexOf(10);if(newline<0)return;handled=true;
   try{
    if(input.subarray(newline+1).toString().trim())throw fault('Invalid frame');
    const command=JSON.parse(input.subarray(0,newline).toString('utf8'));
    if(!command||typeof command!=='object'||Array.isArray(command))throw fault('Invalid operation');
    const opening=Object.keys(command).length===1&&command.operation==='open';
    const stopping=Object.keys(command).length===4&&command.operation==='shutdown'&&command.pid===process.pid&&command.device===String(this.socketStat.dev)&&command.inode===String(this.socketStat.ino)&&typeof this.shutdown==='function';
    if(!opening&&!stopping)throw fault('Invalid operation');
    const current=owned(await lstat(this.socketPath),{socket:true});
    if(current.dev!==this.socketStat.dev||current.ino!==this.socketStat.ino)throw fault('Socket replaced');
    await directoryPath(this.directory);
    if(stopping){
     const record=await ownerManifest(this.directory,current);
     if(record.info.dev!==this.manifestStat.dev||record.info.ino!==this.manifestStat.ino||record.owner.pid!==process.pid)throw fault('Owner replaced');
    }
    if(this.closing||this.shutdownRequested)return socket.destroy();
    if(stopping){
     this.shutdownRequested=true;
     // Acceptance is not completion. The client verifies this exact PID is gone
     // and both owned control entries are absent before reporting a stop.
     socket.end(JSON.stringify({ok:true,shutdown:'accepted'})+'\n',()=>{Promise.resolve().then(()=>this.shutdown()).catch(()=>{});});
    }else{
     const url=validateLaunchUrl(await this.issueLaunchUrl());
     if(!socket.destroyed&&!this.closing&&!this.shutdownRequested)socket.end(JSON.stringify({ok:true,url})+'\n');
    }
   }catch{if(!socket.destroyed)socket.end('{"ok":false,"error":"launch_refused"}\n');}
  });
 }
 async close(){
  this.closing=true;for(const socket of this.connections)socket.destroy();let recovery=null;
  if(this.server?.listening){
   try{const current=await lstat(this.socketPath);if(!current.isSocket()||current.isSymbolicLink()||current.uid!==uid()||current.dev!==this.socketStat.dev||current.ino!==this.socketStat.ino){
     if(current.uid!==uid()||current.isDirectory())throw fault('The private launch path changed. Preserve it and stop this process before repairing the path.','LOCAL_LAUNCH_PATH_CHANGED');
     await directoryPath(this.directory);const recoveryDirectory=path.join(this.directory,'.control-recovery-'+randomUUID());await mkdir(recoveryDirectory,{mode:0o700});const entry=path.join(recoveryDirectory,'entry');
     const observed=await lstat(this.socketPath);if(observed.dev!==current.dev||observed.ino!==current.ino)throw fault('The launch path changed again before preservation.','LOCAL_LAUNCH_PATH_CHANGED');
     await rename(this.socketPath,entry);recovery={directory:recoveryDirectory,entry,symlink:current.isSymbolicLink(),device:String(current.dev),inode:String(current.ino),mode:current.mode&0o777};
     await writeFile(path.join(recoveryDirectory,'receipt.json'),JSON.stringify({application:APP,original:'control.sock',device:recovery.device,inode:recovery.inode,mode:recovery.mode,state:'preserved',at:new Date().toISOString()}),{mode:0o600,flag:'wx'});
   }}catch(error){if(!missing(error)){this.server.unref();throw error;}}
   await new Promise(resolve=>this.server.close(resolve));
  }
  this.server=null;
  if(recovery){try{if(recovery.symlink)await symlink(await readlink(recovery.entry),this.socketPath);else await link(recovery.entry,this.socketPath);await unlink(recovery.entry);await writeFile(path.join(recovery.directory,'receipt.json'),JSON.stringify({application:APP,original:'control.sock',device:recovery.device,inode:recovery.inode,mode:recovery.mode,state:'restored',at:new Date().toISOString()}),{mode:0o600});}catch(error){const held=fault('The replacement was preserved in the private recovery directory; a newer path was left untouched.','LOCAL_LAUNCH_RECOVERY_HELD');held.recoveryPath=recovery.entry;throw held;}}
  if(this.manifestStat){try{const stat=owned(await lstat(this.manifestPath),{file:true});if(stat.dev===this.manifestStat.dev&&stat.ino===this.manifestStat.ino)await unlink(this.manifestPath);}catch(error){if(!missing(error))throw error;}}
  return recovery?{preservedReplacement:true,recoveryDirectory:recovery.directory}:{closed:true};
 }
}

export async function openExisting({directory,openBrowser=nativeOpen}={}){let resolved;try{resolved=await directoryPath(directory)}catch(error){if(missing(error))return {opened:false,reason:'absent'};throw error;}const socketPath=path.join(resolved,'control.sock');let stat;try{stat=owned(await lstat(socketPath),{socket:true});await ownerManifest(resolved,stat)}catch(error){if(missing(error))return {opened:false,reason:'absent'};throw error;}let socket;try{socket=await connect(socketPath)}catch(error){if(['ENOENT','ECONNREFUSED'].includes(error.code))return {opened:false,reason:'refused'};throw error;}const reply=await new Promise((resolve,reject)=>{let data=Buffer.alloc(0),done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);socket.destroy();error?reject(error):resolve(value)};const timer=setTimeout(()=>finish(fault('The running hub did not answer its private launch request.','LOCAL_LAUNCH_TIMEOUT')),TIMEOUT);socket.on('error',error=>finish(error));socket.on('close',()=>{if(!done)finish(fault('The running hub closed its private launch request.','LOCAL_LAUNCH_PROTOCOL'))});socket.on('data',chunk=>{if(data.length+chunk.length>LIMIT)return finish(fault('The running hub returned an oversized launch response.','LOCAL_LAUNCH_PROTOCOL'));data=Buffer.concat([data,chunk]);const newline=data.indexOf(10);if(newline<0)return;try{if(data.subarray(newline+1).toString().trim())throw new Error();const message=JSON.parse(data.subarray(0,newline).toString());if(message.ok!==true)throw new Error();finish(null,validateLaunchUrl(message.url));}catch{finish(fault('The running hub refused the private launch request.','LOCAL_LAUNCH_PROTOCOL'))}});socket.write('{"operation":"open"}\n');});try{await openBrowser(reply)}catch(error){throw fault('Native browser opening was denied or failed.',error.code||'NATIVE_OPEN_FAILED')}return {opened:true};}


// Explicit local maintenance only: never acquires a lease, starts a worker,
// removes a stale entry, or signals a PID. A missing endpoint is unverified.
export async function stopExisting({directory,timeoutMs=15000}={}){
 let resolved;
 try{resolved=await directoryPath(directory);}catch(error){if(missing(error))throw fault('No identified running worker.','LOCAL_SHUTDOWN_NOT_RUNNING');throw error;}
 const socketPath=path.join(resolved,'control.sock');let initial,record;
 try{initial=owned(await lstat(socketPath),{socket:true});record=await ownerManifest(resolved,initial);}catch(error){if(missing(error))throw fault('No identified running worker.','LOCAL_SHUTDOWN_NOT_RUNNING');throw error;}
 const checkIdentity=async()=>{
  await directoryPath(resolved);
  let socketPresent=false,manifestPresent=false;
  try{const current=owned(await lstat(socketPath),{socket:true});socketPresent=true;if(current.dev!==initial.dev||current.ino!==initial.ino)throw fault('Worker changed.','LOCAL_SHUTDOWN_CHANGED');}catch(error){if(!missing(error))throw error;}
  try{const current=await ownerManifest(resolved);manifestPresent=true;if(current.info.dev!==record.info.dev||current.info.ino!==record.info.ino||current.owner.pid!==record.owner.pid||current.owner.socketDevice!==record.owner.socketDevice||current.owner.socketInode!==record.owner.socketInode)throw fault('Worker changed.','LOCAL_SHUTDOWN_CHANGED');}catch(error){if(!missing(error))throw error;}
  return {socketPresent,manifestPresent};
 };
 let socket;
 try{socket=await connect(socketPath);}catch(error){if(['ENOENT','ECONNREFUSED'].includes(error.code))throw fault('No identified running worker.','LOCAL_SHUTDOWN_NOT_RUNNING');throw error;}
 try{
  const current=await checkIdentity();if(!current.socketPresent||!current.manifestPresent)throw fault('Worker changed.','LOCAL_SHUTDOWN_CHANGED');
  await new Promise((resolve,reject)=>{
   let data=Buffer.alloc(0),done=false;
   const finish=error=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve();};
   const timer=setTimeout(()=>finish(fault('Shutdown request timed out.','LOCAL_LAUNCH_TIMEOUT')),TIMEOUT);
   socket.on('error',error=>finish(error));socket.on('close',()=>{if(!done)finish(fault('Shutdown not acknowledged.','LOCAL_LAUNCH_PROTOCOL'));});
   socket.on('data',chunk=>{
    if(data.length+chunk.length>LIMIT)return finish(fault('Invalid shutdown response.','LOCAL_LAUNCH_PROTOCOL'));
    data=Buffer.concat([data,chunk]);const newline=data.indexOf(10);if(newline<0)return;
    try{if(data.subarray(newline+1).toString().trim())throw new Error();const message=JSON.parse(data.subarray(0,newline).toString());if(Object.keys(message).length!==2||message.ok!==true||message.shutdown!=='accepted')throw new Error();finish();}catch{finish(fault('Shutdown was refused.','LOCAL_LAUNCH_PROTOCOL'));}
   });
   socket.write(JSON.stringify({operation:'shutdown',pid:record.owner.pid,device:String(initial.dev),inode:String(initial.ino)})+'\n');
  });
 }finally{socket.destroy();}
 const until=Date.now()+timeoutMs;
 do{
  const current=await checkIdentity();
  if(!current.socketPresent&&!current.manifestPresent&&!alive(record.owner.pid))return {stopped:true,verified:true};
  await new Promise(resolve=>setTimeout(resolve,50));
 }while(Date.now()<until);
 throw fault('Shutdown completion was not verified.','LOCAL_SHUTDOWN_TIMEOUT');
}
