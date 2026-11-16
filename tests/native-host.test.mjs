import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,chmod} from 'node:fs/promises';
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
