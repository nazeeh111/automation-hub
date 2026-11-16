// Preserve a verified existing LibreOffice app in the hub's durable runtime.
// No downloads, signature repair, credential access or system installation.
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdir,lstat,readFile,writeFile,readdir,readlink,cp,rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
const exec=promisify(execFile),sha=value=>createHash('sha256').update(value).digest('hex');
const run=async(command,args)=>(await exec(command,args,{maxBuffer:1024*1024})).stdout.trim();
export async function rendererTree(root){const result={};async function walk(dir){for(const item of await readdir(dir,{withFileTypes:true})){const file=path.join(dir,item.name),name=path.relative(root,file);if(item.isDirectory())await walk(file);else if(item.isSymbolicLink())result[name]={link:await readlink(file)};else if(item.isFile())result[name]={sha256:sha(await readFile(file))};else throw new Error('Unsupported renderer file type.');}}await walk(root);return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));}
async function main(){
 const source=process.argv[2];if(!source||!path.isAbsolute(source)||!source.endsWith('.app'))throw new Error('Supply the absolute existing verified LibreOffice .app path.');
 const stat=await lstat(source);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw new Error('Use an owned regular app directory.');
 await run('/usr/bin/codesign',['--verify','--strict',source]);
 const version=await run('/usr/bin/plutil',['-extract','CFBundleShortVersionString','raw','-o','-',path.join(source,'Contents','Info.plist')]);if(!/^[0-9.]{1,24}$/.test(version))throw new Error('Unexpected renderer version.');
 const runtime=path.join(homedir(),'Library','Application Support','Automation Hub','runtime','libreoffice');await mkdir(runtime,{recursive:true,mode:0o700});
 const destination=path.join(runtime,version,path.basename(source)),before=await rendererTree(source);let existing=false;try{const st=await lstat(destination);if(!st.isDirectory()||st.isSymbolicLink()||st.uid!==process.getuid())throw new Error('Existing renderer location is unsafe.');existing=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(!existing){const staging=path.join(runtime,'.install-'+randomUUID());await mkdir(staging,{mode:0o700});const staged=path.join(staging,path.basename(source));await cp(source,staged,{recursive:true,verbatimSymlinks:true,preserveTimestamps:true});await run('/usr/bin/codesign',['--verify','--strict',staged]);if(JSON.stringify(await rendererTree(staged))!==JSON.stringify(before)||JSON.stringify(await rendererTree(source))!==JSON.stringify(before))throw new Error('Renderer source changed or copy verification failed; staging is preserved.');await rename(staging,path.dirname(destination));}
 await run('/usr/bin/codesign',['--verify','--strict',destination]);const installed=await rendererTree(destination);if(JSON.stringify(installed)!==JSON.stringify(before))throw new Error('Existing renderer differs; it was left intact.');
 const entryPoint=path.join(destination,'Contents','MacOS','soffice'),record={version,source,destination,entryPoint,sourceTreeSha256:sha(JSON.stringify(before)),installedTreeSha256:sha(JSON.stringify(installed)),files:Object.keys(installed).length,signatureVerified:true,licensesPreserved:true,observedAt:new Date().toISOString(),reused:existing};
 await writeFile(path.join(runtime,'renderer.json'),JSON.stringify(record,null,2)+'\n',{mode:0o600});
 const evidence=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','docs','native-app');await mkdir(evidence,{recursive:true});await writeFile(path.join(evidence,'RENDERER_INSTALL.json'),JSON.stringify(record,null,2)+'\n');
 console.log(`Verified LibreOffice ${version} retained in the private hub runtime (${record.files} files/links).`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
