import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,mkdir,writeFile,rm,symlink,link,lstat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {readNodeLicense,NODE_LICENSE_MAX_BYTES} from '../scripts/node-license.mjs';

const bytes=Buffer.from('Node.js is licensed for use as follows:\r\n\r\n"""\r\nSynthetic complete fixture bytes.\r\n"""\r\nRetained dependency notices: café.\r\n');
async function setup(t){const root=await mkdtemp(path.join(tmpdir(),'hub-node-license-'));t.after(()=>rm(root,{recursive:true,force:true}));const executable=path.join(root,'bin','node'),license=path.join(root,'LICENSE');await mkdir(path.dirname(executable));return {root,executable,license};}
const unavailable=error=>error.code==='NODE_LICENSE_UNAVAILABLE'&&/HUB_NODE_LICENSE/.test(error.message)&&/No license is downloaded/.test(error.message);

test('Node license preflight preserves every byte from the current distribution layout',async t=>{
 const {executable,license}=await setup(t);await writeFile(license,bytes);
 assert.deepEqual(await readNodeLicense({executable,override:undefined}),bytes);
});
test('an explicit absolute Node license overrides the default without changing its bytes',async t=>{
 const {root,executable,license}=await setup(t);await writeFile(license,'invalid default');const selected=path.join(root,'selected-license');await writeFile(selected,bytes);
 assert.deepEqual(await readNodeLicense({executable,override:selected}),bytes);
});
test('missing Node license yields actionable failure without creating a fallback',async t=>{
 const {executable}=await setup(t);await assert.rejects(readNodeLicense({executable,override:undefined}),unavailable);
});
test('an explicit missing Node license cannot silently use a valid default',async t=>{
 const {root,executable,license}=await setup(t);await writeFile(license,bytes);
 await assert.rejects(readNodeLicense({executable,override:path.join(root,'missing-license')}),unavailable);
});
test('relative, empty and invalid Node license overrides are rejected',async t=>{
 const {executable,license}=await setup(t);await writeFile(license,bytes);
 for(const override of ['LICENSE','',null,42,'/bad\0license'])await assert.rejects(readNodeLicense({executable,override}),unavailable);
});
test('a symlink or hardlink cannot stand in for the selected Node license',async t=>{
 const {root,executable,license}=await setup(t);await writeFile(license,bytes);const alias=path.join(root,'alias');await symlink(license,alias);
 await assert.rejects(readNodeLicense({executable,override:alias}),unavailable);
 await rm(alias);await link(license,alias);await assert.rejects(readNodeLicense({executable,override:alias}),unavailable);
});
test('a directory, empty, oversized, unrelated or binary file is not a usable Node license',async t=>{
 const {root,executable,license}=await setup(t);
 await assert.rejects(readNodeLicense({executable,override:root}),unavailable);
 for(const content of [Buffer.alloc(0),Buffer.alloc(NODE_LICENSE_MAX_BYTES+1,65),Buffer.from('A different library license'),Buffer.concat([bytes,Buffer.from([0])])]){
  await writeFile(license,content);await assert.rejects(readNodeLicense({executable,override:license}),unavailable);
 }
});
test('a failed native license preflight creates no cache or application output',{skip:process.platform!=='darwin'},async t=>{
 const {root}=await setup(t),target=path.join(root,'output','Automation Hub.app'),run=promisify(execFile);
 await assert.rejects(run(process.execPath,[fileURLToPath(new URL('../scripts/build-native.mjs',import.meta.url)),'--output',target],{env:{HOME:root,PATH:'/usr/bin:/bin',HUB_NODE_LICENSE:path.join(root,'missing-license')},timeout:10000}),error=>error.code===1&&/HUB_NODE_LICENSE/.test(error.stderr));
 for(const candidate of [target,path.join(root,'output'),path.join(root,'Library')])await assert.rejects(lstat(candidate),error=>error.code==='ENOENT');
});
