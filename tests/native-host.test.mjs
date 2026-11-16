import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,readFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ensureDesktopHub,launchDesktop} from '../scripts/native-host.mjs';
const exec=promisify(execFile),ticket='a'.repeat(64),url=`http://127.0.0.1:4317/auth?ticket=${ticket}`;
test('native launcher attaches to an existing private worker without spawning or opening a browser',async()=>{
 let starts=0;const result=await ensureDesktopHub({open:async({openBrowser})=>{await openBrowser(url);return {opened:true};},start:()=>{starts++;}});
 assert.deepEqual(result,{url,started:false});assert.equal(starts,0);
});
test('native private-launch denial never attempts an alternate start',async()=>{
 let starts=0;await assert.rejects(ensureDesktopHub({open:async()=>{throw Object.assign(new Error('denied'),{code:'LOCAL_LAUNCH_MODE'});},start:()=>{starts++;}}),{code:'LOCAL_LAUNCH_MODE'});assert.equal(starts,0);
});
test('native browser handoff uses a new ticket and fixed connections fragment only',async()=>{
 let opened;assert.deepEqual(await launchDesktop('browser-connections',{ensure:async()=>({url}),openBrowser:async value=>{opened=value;}}),{opened:true});assert.equal(opened,url+'#connections');
 await assert.rejects(launchDesktop('execute-arbitrary-command',{ensure:()=>assert.fail('must reject before launch')}),{code:'NATIVE_OPERATION'});
 await assert.rejects(launchDesktop('window',{ensure:async()=>({url:'https://foreign.invalid/auth?ticket='+ticket})}));
});
test('native cold start from minimal GUI environment reuses one actual worker and preserves private state',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-native-'));await chmod(directory,0o700);let pid;
 t.after(async()=>{if(pid){try{process.kill(pid,'SIGTERM');}catch{}for(let i=0;i<100;i++){try{process.kill(pid,0);}catch{break;}await new Promise(r=>setTimeout(r,50));}}await rm(directory,{recursive:true,force:true});});
 const env={HOME:process.env.HOME,PATH:'/usr/bin:/bin',HUB_DATA_DIR:directory,HUB_PORT:'0'};
 const call=async()=>JSON.parse((await exec(process.execPath,['scripts/native-host.mjs','window'],{cwd:process.cwd(),env,timeout:20000,maxBuffer:8192})).stdout);
 const first=await call();pid=JSON.parse(await readFile(path.join(directory,'control-owner.json'),'utf8')).pid;
 const auth=await fetch(first.url,{redirect:'manual'});assert.equal(auth.status,303);const cookie=auth.headers.get('set-cookie').split(';')[0],base=new URL(first.url).origin;
 assert.equal((await fetch(first.url,{redirect:'manual'})).status,401);
 const state=await (await fetch(base+'/api/state',{headers:{Cookie:cookie}})).json();assert.equal(state.campaign.enabled,false);assert.equal(state.jobs.length,0);
 const second=await call();assert.notEqual(second.url,first.url);assert.equal(JSON.parse(await readFile(path.join(directory,'control-owner.json'),'utf8')).pid,pid);
 assert.equal((await fetch(second.url,{redirect:'manual'})).status,303);
});

test('explicit native capability settings beat captured configuration and survive GUI capture',async()=>{
 const {desktopEnvironment}=await import('../scripts/native-host.mjs');
 const {captureNativeConfiguration}=await import('../scripts/build-native.mjs');
 const environment={HUB_CODEX_BIN:'/synthetic/custom/codex',HUB_SOFFICE_BIN:'/synthetic/custom/soffice',PLAYWRIGHT_BROWSERS_PATH:'/synthetic/custom/browsers'};
 const config=await captureNativeConfiguration({environment,find:()=>assert.fail('explicit tools must not fall back'),getRenderer:()=>assert.fail('explicit renderer must not read private fallback')});
 assert.equal(config.codex,environment.HUB_CODEX_BIN);assert.equal(config.soffice,environment.HUB_SOFFICE_BIN);assert.equal(config.browsers,environment.PLAYWRIGHT_BROWSERS_PATH);
 const captured=await desktopEnvironment({environment:{HOME:'/synthetic-home'},config});
 for(const key of Object.keys(environment))assert.equal(captured[key],environment[key]);
 const runtime=await desktopEnvironment({environment,config:{codex:'/synthetic/captured/codex',soffice:'/synthetic/captured/soffice',browsers:'/synthetic/captured/browsers'}});
 for(const key of Object.keys(environment))assert.equal(runtime[key],environment[key]);
});
test('invalid explicit tool paths reject before discovery or worker acquisition',async()=>{
 const {desktopEnvironment}=await import('../scripts/native-host.mjs');
 const {captureNativeConfiguration}=await import('../scripts/build-native.mjs');
 for(const value of ['relative-tool','', '/synthetic\nprivate', '/'+ 'x'.repeat(4096)]){
  for(const key of ['HUB_CODEX_BIN','HUB_SOFFICE_BIN','PLAYWRIGHT_BROWSERS_PATH']){
   await assert.rejects(desktopEnvironment({environment:{[key]:value},config:{}}),{code:'HUB_CAPABILITY_PATH'});
   await assert.rejects(captureNativeConfiguration({environment:{[key]:value},find:()=>assert.fail('no fallback')}),{code:'HUB_CAPABILITY_PATH'});
  }
 }
});
test('native startup reports allowlisted occupied-port failure before its timeout',async t=>{
 const net=await import('node:net'),busy=net.createServer();await new Promise(resolve=>busy.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>busy.close(resolve)));
 const directory=await mkdtemp('/tmp/hub-start-failure-');t.after(()=>rm(directory,{recursive:true,force:true}));
 const began=Date.now();
 await assert.rejects(exec(process.execPath,['scripts/native-host.mjs','window'],{cwd:process.cwd(),env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin',HUB_DATA_DIR:directory,HUB_PORT:String(busy.address().port)},timeout:5000}),error=>error.code===1&&error.stderr.trim()==='HUB_PORT_IN_USE'&&!error.stdout);
 assert(Date.now()-began<5000);
});
test('source startup gives specific invalid-directory advice without raw exception details',async()=>{
 await assert.rejects(exec(process.execPath,['scripts/launch.mjs'],{cwd:process.cwd(),env:{HOME:process.env.HOME,PATH:'/usr/bin:/bin',HUB_DATA_DIR:'synthetic-relative-private'},timeout:5000}),error=>error.code===1&&/HUB_DATA_DIRECTORY:.*absolute private directory/.test(error.stderr)&&!error.stderr.includes('synthetic-relative-private')&&!error.stderr.includes(' at '));
});
test('native shutdown delegates to control without acquiring or reopening a worker',async()=>{
 let stops=0;const result=await launchDesktop('shutdown',{stop:async()=>{stops++;return {stopped:true,verified:true};},ensure:()=>assert.fail('shutdown must not acquire'),openBrowser:()=>assert.fail('shutdown must not open')});
 assert.deepEqual(result,{stopped:true,verified:true});assert.equal(stops,1);
});
test('unknown child diagnostics are not disclosed and true pending startup remains bounded',async()=>{
 const {EventEmitter}=await import('node:events');let starts=0;
 const began=Date.now();
 await assert.rejects(ensureDesktopHub({timeoutMs:2000,open:async()=>({opened:false,reason:'absent'}),start:()=>{starts++;const child=new EventEmitter();process.nextTick(()=>{child.emit('message',{type:'startup-error',code:'PRIVATE_TICKET_MUST_NOT_LEAK'});child.emit('message',{type:'startup-error',code:'HUB_PORT_IN_USE',private:'must-ignore-extra-field'});child.emit('exit',1);});return child;}}),error=>error.code==='NATIVE_BACKEND_START'&&!error.message.includes('PRIVATE_TICKET')&&!error.message.includes('must-ignore'));
 assert.equal(starts,1);assert(Date.now()-began<2000);
 await assert.rejects(ensureDesktopHub({timeoutMs:60,open:async()=>({opened:false,reason:'absent'}),start:()=>new EventEmitter()}),{code:'NATIVE_BACKEND_TIMEOUT'});
});

test('raw stderr from an actual early-exit child never becomes startup advice',async()=>{
 const {spawn}=await import('node:child_process');const raw='SECRET_UPPERCASE_TICKET_AND_PRIVATE_PATH';let observed='',starts=0;
 await assert.rejects(ensureDesktopHub({timeoutMs:3000,open:async()=>({opened:false,reason:'absent'}),start:()=>{
  starts++;const child=spawn(process.execPath,['-e',`process.stderr.write(${JSON.stringify(raw)});process.exitCode=3`],{stdio:['ignore','ignore','pipe','ipc']});child.stderr.on('data',bytes=>observed+=bytes);return child;
 }}),error=>error.code==='NATIVE_BACKEND_START'&&!error.message.includes(raw));
 assert.equal(starts,1);assert.equal(observed,raw);
});

test('missing absolute capability overrides fail at use without selecting captured or PATH tools',async t=>{
 const directory=await mkdtemp('/tmp/hub-capability-'),bin=path.join(directory,'bin'),marker=path.join(directory,'fallback-used');await mkdir(bin);
 t.after(()=>rm(directory,{recursive:true,force:true}));
 for(const name of ['codex','soffice'])await writeFile(path.join(bin,name),`#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected fallback');process.exit(1);`,{mode:0o700});
 await writeFile(path.join(directory,'config.toml'),'model = "synthetic-model"\n');
 const {desktopEnvironment}=await import('../scripts/native-host.mjs');
 const environment=await desktopEnvironment({environment:{HOME:directory,CODEX_HOME:directory,HUB_CODEX_BIN:path.join(directory,'missing-codex'),HUB_SOFFICE_BIN:path.join(directory,'missing-soffice'),PLAYWRIGHT_BROWSERS_PATH:path.join(directory,'missing-browsers')},config:{codex:path.join(bin,'codex'),soffice:path.join(bin,'soffice'),browsers:'/synthetic/captured-browser',executableDirectories:[bin]}});
 const script=`
  import assert from 'node:assert/strict';import path from 'node:path';import {writeFile} from 'node:fs/promises';
  import {zipSync,strToU8} from 'fflate';import {chromium} from 'playwright';
  import {Store} from './server/store.mjs';import {ModelService} from './server/model.mjs';import {renderDocx} from './server/resumes.mjs';
  const directory=process.env.HOME,store=new Store(path.join(directory,'store')),model=new ModelService({store,directory,authChecker:async()=>({mode:'chatgpt'})});
  try{
   await assert.rejects(model.probe(),error=>error.code==='model_unavailable'&&error.message.includes('HUB_CODEX_BIN'));
   const file=path.join(directory,'synthetic.docx');await writeFile(file,zipSync({
    '[Content_Types].xml':strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    '_rels/.rels':strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/document.xml':strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic candidate</w:t></w:r></w:p></w:body></w:document>')
   }));
   await assert.rejects(renderDocx(file,path.join(directory,'output.pdf')),{code:'renderer_missing'});
   await assert.rejects(chromium.launch({headless:true}),error=>error.message.includes(process.env.PLAYWRIGHT_BROWSERS_PATH)&&error.message.includes("Executable doesn't exist"));
   console.log(JSON.stringify({model:'model_unavailable',renderer:'renderer_missing',browser:'configured_missing'}));
  }finally{await model.close();store.close();}
 `;
 const result=await exec(process.execPath,['--input-type=module','-e',script],{cwd:process.cwd(),env:environment,timeout:10000,maxBuffer:8192});
 assert.deepEqual(JSON.parse(result.stdout),{model:'model_unavailable',renderer:'renderer_missing',browser:'configured_missing'});
 await assert.rejects(readFile(marker),{code:'ENOENT'});
});
