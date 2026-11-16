import '../server/runtime.mjs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {mkdir,lstat} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';
// Browser installation must not create a broadly readable hub parent first.
const privateRoot=path.join(homedir(),'Library','Application Support','Automation Hub');
if(process.argv[2]==='install'&&process.env.PLAYWRIGHT_BROWSERS_PATH===path.join(privateRoot,'runtime','browsers')){
 await mkdir(privateRoot,{recursive:true,mode:0o700});const info=await lstat(privateRoot);
 if(info.isSymbolicLink()||!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o7777)!==0o700){console.error('Browser setup requires the owned, private hub directory (0700). Inspect its owner and permissions before continuing.');process.exit(1);}
}
const child=spawn(process.execPath,[fileURLToPath(new URL('../node_modules/playwright/cli.js',import.meta.url)),...process.argv.slice(2)],{stdio:'inherit',env:process.env});
child.on('error',()=>{console.error('Install the locked project dependencies with npm ci --ignore-scripts.');process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
