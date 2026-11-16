import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('native completed downloads preserve approved generations, late writers and recovery bytes', {skip:process.platform!=='darwin',timeout:120000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-download-binary-'));try{
  const binary=path.join(directory,'native-download-checks');
  await exec('/usr/bin/xcrun',['swiftc','-swift-version','5','native/DownloadStore.swift','tests/native-downloads.swift','-o',binary],{timeout:60000});
  const result=JSON.parse((await exec(binary,[],{timeout:30000,maxBuffer:1024*1024})).stdout);
  if(process.env.HUB_NATIVE_DOWNLOAD_REPORT)await writeFile(process.env.HUB_NATIVE_DOWNLOAD_REPORT,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  assert.equal(result.checks,18);assert.equal(result.passed,18,JSON.stringify(result.results.filter(r=>r.status==='failed')));assert.equal(result.failed,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
