import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
test('native display readiness uses actual Swift transitions for trusted commits, stale launches, deadlines and preview isolation',{skip:process.platform!=='darwin',timeout:120000},async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-readiness-binary-'));
 try{
  const binary=path.join(directory,'native-readiness-checks');
  await exec('/usr/bin/xcrun',['swiftc','-swift-version','5','native/DisplayReadiness.swift','tests/native-readiness.swift','-o',binary],{timeout:60000});
  const result=JSON.parse((await exec(binary,[],{timeout:10000,maxBuffer:1024*1024})).stdout);
  if(process.env.HUB_NATIVE_READINESS_REPORT)await writeFile(process.env.HUB_NATIVE_READINESS_REPORT,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  assert.equal(result.checks,15);assert.equal(result.failed,0,JSON.stringify(result.results.filter(row=>row.status==='failed')));assert.equal(result.passed,15);
 }finally{await rm(directory,{recursive:true,force:true});}
});
