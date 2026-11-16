import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdtemp,mkdir,writeFile,readFile,rename,rm,cp,lstat,readdir,chmod} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../server/store.mjs';
import {stopExisting} from '../server/local-launch.mjs';
const exec=promisify(execFile),root=process.cwd(),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const env=directory=>({HOME:process.env.HOME,PATH:'/usr/bin:/bin',HUB_DATA_DIR:directory,HUB_PORT:'0'});
async function launch(directory){
 const {stdout}=await exec(process.execPath,['scripts/native-host.mjs','window'],{cwd:root,env:env(directory),timeout:10000,maxBuffer:8192});
 const result=JSON.parse(stdout),auth=await fetch(result.url,{redirect:'manual'});assert.equal(auth.status,303);
 return {url:result.url,base:new URL(result.url).origin,cookie:auth.headers.get('set-cookie').split(';')[0],owner:JSON.parse(await readFile(path.join(directory,'control-owner.json'),'utf8'))};
}
async function state(worker){const response=await fetch(worker.base+'/api/state',{headers:{Cookie:worker.cookie}});assert.equal(response.status,200);return response.json();}
async function stop(directory){return exec(process.execPath,['scripts/service-control.mjs','stop'],{cwd:root,env:env(directory),timeout:20000,maxBuffer:8192});}
async function fixture(t){
 const directory=await mkdtemp('/tmp/hub-control-');
 t.after(async()=>{try{await stopExisting({directory,timeoutMs:5000});}catch(error){if(error.code!=='LOCAL_SHUTDOWN_NOT_RUNNING')throw error;}await rm(directory,{recursive:true,force:true});});
 return directory;
}
async function tree(directory){const result={};async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name);if(item.isDirectory())await walk(file);else if(item.isFile())result[path.relative(directory,file)]=sha(await readFile(file));else throw new Error('Unexpected fixture entry');}}await walk(directory);return result;}

test('cold-start polling sees a private socket before asynchronous startup can publish its owner',async t=>{
 const directory=await mkdtemp('/tmp/hub-control-bind-');t.after(()=>rm(directory,{recursive:true,force:true}));
 // Isolate the process-wide creation mask. Holding only listen's callback
 // reproduces the real boundary before start resumes at its first await.
 const script=`
  import assert from 'node:assert/strict';import net from 'node:net';import path from 'node:path';import {lstat} from 'node:fs/promises';
  import {LocalLaunchServer,openExisting} from ${JSON.stringify(new URL('../server/local-launch.mjs',import.meta.url).href)};
  const directory=process.argv[1],socketPath=path.join(directory,'control.sock'),originalListen=net.Server.prototype.listen;
  let bound,release,issues=0;const atBind=new Promise(resolve=>bound=resolve),continueStartup=new Promise(resolve=>release=resolve);
  net.Server.prototype.listen=function(...args){
   if(typeof args[0]==='string'&&args[0].endsWith('/control.sock')){const callback=args.pop();args.push(()=>{bound();continueStartup.then(callback);});}
   return originalListen.apply(this,args);
  };
  const originalMask=process.umask(0),control=new LocalLaunchServer({directory,issueLaunchUrl:()=>{issues++;return 'http://127.0.0.1:4317/auth?ticket='+'a'.repeat(64);}}),starting=control.start();
  try{
   await atBind;
   assert.equal(process.umask(),0,'listen must restore the caller mask before its callback');
   assert.deepEqual(await openExisting({directory,openBrowser:()=>assert.fail('unpublished owner must not open')}),{opened:false,reason:'absent'});
   assert.equal((await lstat(socketPath)).mode&0o7777,0o600);
   assert.equal(issues,0);
   release();await starting;
   assert.deepEqual(await openExisting({directory,openBrowser:()=>{}}),{opened:true});assert.equal(issues,1);
   await control.close();
   net.Server.prototype.listen=function(){throw Object.assign(new Error('synthetic bind failure'),{code:'EACCES'});};
   const refused=new LocalLaunchServer({directory,issueLaunchUrl:()=>assert.fail('failed bind must not issue')});
   await assert.rejects(refused.start(),{code:'EACCES'});assert.equal(process.umask(),0,'synchronous bind failures must also restore the mask');
   console.log(JSON.stringify({initialSocketMode:'0600',unpublished:'absent',restoredMask:'0000',published:'opened',failedBindMaskRestored:true,issues}));
  }finally{release();await starting;net.Server.prototype.listen=originalListen;process.umask(originalMask);await control.close();}
 `;
 const child=await exec(process.execPath,['--input-type=module','-e',script,directory],{cwd:root,timeout:5000,maxBuffer:8192});
 assert.equal(child.stderr,'');assert.deepEqual(JSON.parse(child.stdout),{initialSocketMode:'0600',unpublished:'absent',restoredMask:'0000',published:'opened',failedBindMaskRestored:true,issues:1});
});

test('cold-start polling cannot observe an empty or partial launch owner record',async t=>{
 const directory=await mkdtemp('/tmp/hub-control-record-');t.after(()=>rm(directory,{recursive:true,force:true}));
 const script=`
  import assert from 'node:assert/strict';import path from 'node:path';import {open,unlink,readdir} from 'node:fs/promises';
  import {LocalLaunchServer,openExisting} from ${JSON.stringify(new URL('../server/local-launch.mjs',import.meta.url).href)};
  const directory=process.argv[1],probe=path.join(directory,'file-handle-probe'),handle=await open(probe,'wx',0o600),prototype=Object.getPrototypeOf(handle),originalWrite=prototype.writeFile;
  await handle.close();await unlink(probe);
  let writing,release,issues=0;const atWrite=new Promise(resolve=>writing=resolve),continueStartup=new Promise(resolve=>release=resolve);
  prototype.writeFile=function(value,...args){
   if(typeof value==='string'&&value.includes('personal-automation-hub-local-launch')){writing();return continueStartup.then(()=>originalWrite.call(this,value,...args));}
   return originalWrite.call(this,value,...args);
  };
  const control=new LocalLaunchServer({directory,issueLaunchUrl:()=>{issues++;return 'http://127.0.0.1:4317/auth?ticket='+'a'.repeat(64);}}),starting=control.start();
  try{
   await atWrite;
   assert.deepEqual(await openExisting({directory,openBrowser:()=>assert.fail('unpublished owner must not open')}),{opened:false,reason:'absent'});assert.equal(issues,0);
   release();await starting;
   assert.deepEqual(await openExisting({directory,openBrowser:()=>{}}),{opened:true});assert.equal(issues,1);
   assert.deepEqual((await readdir(directory)).sort(),['control-owner.json','control.sock']);
   console.log(JSON.stringify({duringWrite:'absent',published:'opened',stagingCleaned:true,issues}));
  }finally{release();await starting;prototype.writeFile=originalWrite;await control.close();}
 `;
 const child=await exec(process.execPath,['--input-type=module','-e',script,directory],{cwd:root,timeout:5000,maxBuffer:8192});
 assert.equal(child.stderr,'');assert.deepEqual(JSON.parse(child.stdout),{duringWrite:'absent',published:'opened',stagingCleaned:true,issues:1});
});

test('owner publication refuses a newer final path and removes only its own staged file',async t=>{
 const directory=await mkdtemp('/tmp/hub-control-publish-');t.after(()=>rm(directory,{recursive:true,force:true}));
 const script=`
  import assert from 'node:assert/strict';import path from 'node:path';import {open,writeFile,readFile,unlink,readdir} from 'node:fs/promises';
  import {LocalLaunchServer} from ${JSON.stringify(new URL('../server/local-launch.mjs',import.meta.url).href)};
  const directory=process.argv[1],marker=path.join(directory,'control-owner.json'),replacement='newer unrelated owner bytes',probe=path.join(directory,'file-handle-probe'),handle=await open(probe,'wx',0o600),prototype=Object.getPrototypeOf(handle),originalWrite=prototype.writeFile;
  await handle.close();await unlink(probe);let issues=0;
  prototype.writeFile=async function(value,...args){
   const result=await originalWrite.call(this,value,...args);
   if(typeof value==='string'&&value.includes('personal-automation-hub-local-launch'))await writeFile(marker,replacement,{mode:0o600,flag:'wx'});
   return result;
  };
  const control=new LocalLaunchServer({directory,issueLaunchUrl:()=>{issues++;throw new Error('no ticket permitted');}});
  try{
   await assert.rejects(control.start(),{code:'EEXIST'});
   assert.equal(await readFile(marker,'utf8'),replacement);assert.deepEqual(await readdir(directory),['control-owner.json']);assert.equal(issues,0);
   console.log(JSON.stringify({newerOwnerRetained:true,ownStagingRemoved:true,issues}));
  }finally{prototype.writeFile=originalWrite;await control.close();}
 `;
 const child=await exec(process.execPath,['--input-type=module','-e',script,directory],{cwd:root,timeout:5000,maxBuffer:8192});
 assert.equal(child.stderr,'');assert.deepEqual(JSON.parse(child.stdout),{newerOwnerRetained:true,ownStagingRemoved:true,issues:0});
});

test('service CLI verifies exact worker exit, closed HTTP/control and released SQLite lease',async t=>{
 const directory=await fixture(t),worker=await launch(directory);
 const before=await state(worker);assert.equal(before.campaign.enabled,false);
 const stopped=await stop(directory);assert.match(stopped.stdout,/process exited.*control entries are gone/);assert.equal(stopped.stderr,'');assert(!stopped.stdout.includes(worker.url));
 assert.throws(()=>process.kill(worker.owner.pid,0),{code:'ESRCH'});
 for(const name of ['control.sock','control-owner.json'])await assert.rejects(lstat(path.join(directory,name)),{code:'ENOENT'});
 await assert.rejects(fetch(worker.base+'/api/state',{headers:{Cookie:worker.cookie}}));
 const db=new DatabaseSync(path.join(directory,'live','hub.sqlite'));try{assert.equal(db.prepare("SELECT value FROM metadata WHERE key='worker'").get(),undefined);}finally{db.close();}
 await assert.rejects(stop(directory),error=>error.code===1&&/LOCAL_SHUTDOWN_NOT_RUNNING/.test(error.stderr)&&!error.stdout);
});

test('shutdown refuses changed owner generation and retains the running worker and replacement bytes',async t=>{
 const directory=await fixture(t),worker=await launch(directory),marker=path.join(directory,'control-owner.json'),saved=await readFile(marker);
 await rename(marker,marker+'.preserved');await writeFile(marker,saved,{mode:0o600});
 try{
  await assert.rejects(stopExisting({directory}),{code:'LOCAL_LAUNCH_PROTOCOL'});
  assert.deepEqual(await readFile(marker),saved);assert.equal((await state(worker)).campaign.enabled,false);
  await chmod(marker,0o644);await assert.rejects(stopExisting({directory}),{code:'LOCAL_LAUNCH_MODE'});
  assert.deepEqual(await readFile(marker),saved);assert.equal((await state(worker)).campaign.enabled,false);await chmod(marker,0o600);
  const changed={...worker.owner,uid:process.getuid()+1};await writeFile(marker,JSON.stringify(changed),{mode:0o600});const changedBytes=await readFile(marker);
  await assert.rejects(stopExisting({directory}),{code:'LOCAL_LAUNCH_OWNER'});
  assert.deepEqual(await readFile(marker),changedBytes);assert.equal((await state(worker)).campaign.enabled,false);
 }finally{await rm(marker);await rename(marker+'.preserved',marker);}
 await stop(directory);
});

test('accepted shutdown is not reported complete while the exact owner remains alive',async t=>{
 const directory=await mkdtemp('/tmp/hub-control-wait-'),{LocalLaunchServer}=await import('../server/local-launch.mjs');let calls=0;
 const control=new LocalLaunchServer({directory,issueLaunchUrl:()=>assert.fail('shutdown never issues a ticket'),shutdown:async()=>{calls++;}});await control.start();
 try{await assert.rejects(stopExisting({directory,timeoutMs:100}),{code:'LOCAL_SHUTDOWN_TIMEOUT'});assert.equal(calls,1);assert((await lstat(path.join(directory,'control.sock'))).isSocket());}finally{await control.close();await rm(directory,{recursive:true,force:true});}
});

test('removed control entries do not prove shutdown while the original PID remains alive',async()=>{
 const directory=await mkdtemp('/tmp/hub-control-drained-'),{LocalLaunchServer}=await import('../server/local-launch.mjs');
 const control=new LocalLaunchServer({directory,issueLaunchUrl:()=>assert.fail('no launch ticket'),shutdown:()=>control.close()});await control.start();
 try{
  await assert.rejects(stopExisting({directory,timeoutMs:150}),{code:'LOCAL_SHUTDOWN_TIMEOUT'});
  for(const name of ['control.sock','control-owner.json'])await assert.rejects(lstat(path.join(directory,name)),{code:'ENOENT'});
  assert.doesNotThrow(()=>process.kill(process.pid,0));
 }finally{await control.close();await rm(directory,{recursive:true,force:true});}
});

test('owner replacement after accepted shutdown is retained and cannot be reported stopped',async()=>{
 const directory=await mkdtemp('/tmp/hub-control-replaced-'),{LocalLaunchServer}=await import('../server/local-launch.mjs');
 const marker=path.join(directory,'control-owner.json');let replacement;
 const control=new LocalLaunchServer({directory,issueLaunchUrl:()=>assert.fail('no launch ticket'),shutdown:async()=>{
  const bytes=await readFile(marker);await rename(marker,marker+'.preserved');await writeFile(marker,bytes,{mode:0o600});replacement=bytes;
 }});await control.start();
 try{
  await assert.rejects(stopExisting({directory,timeoutMs:1000}),{code:'LOCAL_SHUTDOWN_CHANGED'});
  assert.deepEqual(await readFile(marker),replacement);assert((await lstat(path.join(directory,'control.sock'))).isSocket());
 }finally{await control.close();if(replacement)assert.deepEqual(await readFile(marker),replacement);await rm(directory,{recursive:true,force:true});}
});

test('FIFO owner records reject promptly without reading, callbacks or changing owned paths',async t=>{
 const directory=await mkdtemp('/tmp/hub-control-fifo-');t.after(()=>rm(directory,{recursive:true,force:true}));
 // Run the complete real FIFO probe in its own child. On a regression, the
 // fixture opens its writer after the deadline so a blocked read can drain;
 // the parent never awaits a FIFO open in its own filesystem thread pool.
 const script=`
  import path from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
  import {readFile,rename,lstat,unlink,open} from 'node:fs/promises';import {constants} from 'node:fs';
  import {LocalLaunchServer,stopExisting,openExisting} from ${JSON.stringify(new URL('../server/local-launch.mjs',import.meta.url).href)};
  const directory=process.argv[1],marker=path.join(directory,'control-owner.json'),socket=path.join(directory,'control.sock');
  let callbacks=0,issues=0,signals=0;const control=new LocalLaunchServer({directory,issueLaunchUrl:()=>{issues++;throw new Error('No launch allowed');},shutdown:()=>{callbacks++;}});
  await control.start();const original=await readFile(marker),socketBefore=await lstat(socket);await rename(marker,marker+'.preserved');
  await promisify(execFile)('/usr/bin/mkfifo',['-m','600',marker]);const fifoBefore=await lstat(marker),results=[];
  const nativeKill=process.kill;process.kill=()=>{signals++;throw new Error('No process signals allowed');};
  try{
   for(const operation of ['stop','open']){
    const began=Date.now();
    const pending=(operation==='stop'?stopExisting({directory,timeoutMs:50}):openExisting({directory,openBrowser:()=>{issues++;}})).then(value=>({value}),error=>({code:error.code}));
    const first=await Promise.race([pending,new Promise(resolve=>setTimeout(()=>resolve({pending:true}),250))]);
    if(first.pending){const writer=await open(marker,constants.O_WRONLY|constants.O_NONBLOCK);await writer.close();}
    const result=await pending,after=await lstat(marker),socketAfter=await lstat(socket);
    results.push({operation,completedBeforeWriterRelease:!first.pending,result,elapsedMs:Date.now()-began,fifoRetained:after.isFIFO()&&after.dev===fifoBefore.dev&&after.ino===fifoBefore.ino&&(after.mode&0o777)===0o600,socketRetained:socketAfter.dev===socketBefore.dev&&socketAfter.ino===socketBefore.ino});
   }
   console.log(JSON.stringify({results,callbacks,issues,signals}));
  }finally{process.kill=nativeKill;await unlink(marker);await rename(marker+'.preserved',marker);if(!(await readFile(marker)).equals(original))throw new Error('Original owner bytes changed');await control.close();}
 `;
 const child=await exec(process.execPath,['--input-type=module','-e',script,directory],{cwd:root,timeout:5000,maxBuffer:8192});
 const report=JSON.parse(child.stdout);assert.equal(child.stderr,'');assert.equal(report.callbacks,0);assert.equal(report.issues,0);assert.equal(report.signals,0);
 t.diagnostic(JSON.stringify(report));
 for(const result of report.results){assert.equal(result.completedBeforeWriterRelease,true,JSON.stringify(result));assert.deepEqual(result.result,{code:'LOCAL_LAUNCH_PATH'});assert.equal(result.fifoRetained,true);assert.equal(result.socketRetained,true);}
 assert.deepEqual(report.results.map(result=>result.operation),['stop','open']);
});

test('verified shutdown permits preserved-current restoration and a fresh paused uncertain worker',async t=>{
 const directory=await fixture(t),live=path.join(directory,'live'),backup=path.join(directory,'snapshot'),preserved=path.join(directory,'preserved-current');
 const store=new Store(live),resumeDir=path.join(live,'resumes','synthetic'),packageDir=path.join(live,'packages','synthetic');
 await mkdir(resumeDir,{recursive:true});await mkdir(packageDir,{recursive:true});
 const original=path.join(resumeDir,'original.md'),final=path.join(packageDir,'final.md'),originalBytes=Buffer.from('# Synthetic Candidate\n- Built a simulated academic prototype.\n'),finalBytes=Buffer.from('# Synthetic Candidate\n- Tested a simulated academic prototype in 12 controlled cases.\n');
 await writeFile(original,originalBytes);await writeFile(final,finalBytes);
 store.put('resume',{id:'synthetic-resume',originalPath:original,renderStatus:'ready'});store.put('package',{id:'synthetic-package',finalPath:final,hash:sha(finalBytes),verified:true});
 store.put('job',{id:'synthetic-job',identity:'main|synthetic|1',url:'https://jobs.lever.co/synthetic/1',title:'Synthetic intern',employer:'Synthetic Employer',state:'applying',revision:0,activeAttemptId:'synthetic-attempt',packageId:'synthetic-package'});
 store.put('run',{id:'synthetic-attempt',jobId:'synthetic-job',state:'dispatched',dispatchedAt:new Date().toISOString(),packageId:'synthetic-package',packageHash:sha(finalBytes)});
 store.put('campaign',{...store.get('campaign','main'),enabled:true,status:'running'});
 await mkdir(backup,{mode:0o700});await store.backup(path.join(backup,'hub.sqlite'));for(const name of ['resumes','packages'])await cp(path.join(live,name),path.join(backup,name),{recursive:true});
 store.put('profile',{...store.get('profile','main'),fullName:'Newer actual dirty fixture bytes'});await writeFile(original,'Newer actual dirty source bytes');store.close();
 const first=await launch(directory);assert.equal((await state(first)).profile.fullName,'Newer actual dirty fixture bytes');await stop(directory);
 const current=await tree(live);await rename(live,preserved);await cp(backup,live,{recursive:true});assert.deepEqual(await tree(preserved),current);
 const second=await launch(directory);assert.notEqual(second.owner.pid,first.owner.pid);assert.notEqual(second.url,first.url);
 const restored=await state(second);assert.equal(restored.campaign.status,'paused');assert.equal(restored.jobs[0].state,'uncertain');assert.equal(restored.jobs[0].activeAttemptId,'synthetic-attempt');assert.notEqual(restored.profile.fullName,'Newer actual dirty fixture bytes');
 assert.deepEqual(await readFile(original),originalBytes);assert.deepEqual(await readFile(final),finalBytes);assert.deepEqual(await tree(preserved),current);
 const retry=await fetch(second.base+'/api/action',{method:'POST',headers:{Cookie:second.cookie,Origin:second.base,'Content-Type':'application/json'},body:JSON.stringify({action:'retry',jobId:'synthetic-job'})});assert.equal(retry.status,409);
 await stop(directory);assert.deepEqual(await tree(preserved),current);
});
