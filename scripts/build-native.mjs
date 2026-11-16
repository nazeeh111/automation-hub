import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {mkdir,readFile,writeFile,cp,rename,lstat,chmod,mkdtemp,readdir,rm,open} from 'node:fs/promises';
import {constants} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readNodeLicense} from './node-license.mjs';
const exec=promisify(execFile),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=data=>createHash('sha256').update(data).digest('hex');
const run=async(command,args,options={})=>(await exec(command,args,{cwd:root,maxBuffer:4*1024*1024,...options})).stdout.trim();
const xml=value=>String(value).replace(/[<>&"']/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
export async function replaceManagedApp(staged,target,{backupDirectory}={}){
 let old;try{old=await lstat(target);}catch(error){if(error.code!=='ENOENT')throw error;}
 if(old){
  if(!old.isDirectory()||old.isSymbolicLink()||old.uid!==process.getuid())throw new Error('Refusing to replace a different owner, link or non-app target.');
  const file=await open(path.join(target,'Contents','Info.plist'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let info;
  try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid()||stat.size>65536)throw new Error('Refusing an unsafe app property list.');const buffer=Buffer.alloc(65537);const {bytesRead}=await file.read(buffer,0,buffer.length,0);if(bytesRead>65536)throw new Error('App property list is too large.');info=buffer.subarray(0,bytesRead);}finally{await file.close();}
  const identifier=await new Promise((resolve,reject)=>{const child=execFile('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-','-'],{maxBuffer:65536},(error,stdout)=>error?reject(new Error('Refusing an invalid app property list.')):resolve(stdout.trim()));child.stdin.on('error',()=>{});child.stdin.end(info);});
  if(identifier!=='local.nazeeh.automationhub')throw new Error('Refusing to replace an unrelated application.');
  if(!backupDirectory)throw new Error('A backup directory is required before replacing an app.');
  await mkdir(backupDirectory,{recursive:true,mode:0o700});
  const saved=path.join(backupDirectory,'Automation Hub-'+new Date().toISOString().replace(/[:.]/g,'-')+'.app');
  await rename(target,saved);
  try{await rename(staged,target);}catch(error){await rename(saved,target);throw error;}
  return {replaced:true,previousApp:saved};
 }
 await rename(staged,target);return {replaced:false};
}
async function main(){
 if(process.platform!=='darwin')throw new Error('Build the Mac app on macOS with Xcode command-line tools.');
 const args=process.argv.slice(2),index=args.indexOf('--output'),target=index<0?path.join(os.homedir(),'Applications','Automation Hub.app'):path.resolve(args[index+1]);
 if(!target.endsWith('.app'))throw new Error('Choose an .app output path.');
 const nodeLicense=await readNodeLicense({override:process.env.HUB_NODE_LICENSE});
 const cache=path.join(os.homedir(),'Library','Caches','Automation Hub');await mkdir(cache,{recursive:true,mode:0o700});
 const build=await mkdtemp(path.join(cache,'native-build-')),app=path.join(build,'Automation Hub.app'),contents=path.join(app,'Contents'),resources=path.join(contents,'Resources'),hub=path.join(resources,'hub');
 await mkdir(path.join(contents,'MacOS'),{recursive:true});await mkdir(path.join(resources,'runtime','bin'),{recursive:true});await mkdir(hub);
 const version=JSON.parse(await readFile(path.join(root,'package.json'),'utf8')).version;
 const info=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
 <key>CFBundleIdentifier</key><string>local.nazeeh.automationhub</string><key>CFBundleName</key><string>Automation Hub</string><key>CFBundleDisplayName</key><string>Automation Hub</string><key>CFBundleExecutable</key><string>AutomationHub</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${xml(version)}</string><key>CFBundleVersion</key><string>4</string><key>CFBundleIconFile</key><string>AutomationHub</string><key>LSMinimumSystemVersion</key><string>13.5</string><key>LSApplicationCategoryType</key><string>public.app-category.productivity</string><key>NSHighResolutionCapable</key><true/><key>NSPrincipalClass</key><string>NSApplication</string><key>LSMultipleInstancesProhibited</key><true/>
 <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/><key>NSExceptionDomains</key><dict><key>127.0.0.1</key><dict><key>NSExceptionAllowsInsecureHTTPLoads</key><true/><key>NSIncludesSubdomains</key><false/></dict></dict></dict>
 </dict></plist>`;
 await writeFile(path.join(contents,'Info.plist'),info);await writeFile(path.join(contents,'PkgInfo'),'APPL????');
 await run('/usr/bin/xcrun',['swiftc','-swift-version','5','-target',`${process.arch==='arm64'?'arm64':'x86_64'}-apple-macos13.5`,'-O','-framework','AppKit','-framework','WebKit','native/DownloadStore.swift','native/DisplayReadiness.swift','native/AutomationHub.swift','-o',path.join(contents,'MacOS','AutomationHub')]);
 const icons=path.join(build,'icons'),iconset=path.join(build,'AutomationHub.iconset');await mkdir(icons);await mkdir(iconset);
 await run('/usr/bin/xcrun',['swift','native/Icon.swift',icons]);
 for(const size of [16,32,128,256,512])for(const scale of [1,2])await cp(path.join(icons,`icon-${size*scale}.png`),path.join(iconset,`icon_${size}x${size}${scale===2?'@2x':''}.png`));
 await run('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(resources,'AutomationHub.icns')]);
 await cp(process.execPath,path.join(resources,'runtime','bin','node'));await chmod(path.join(resources,'runtime','bin','node'),0o755);
 await writeFile(path.join(resources,'runtime','NODE-LICENSE.txt'),nodeLicense);
 for(const entry of ['server','dist','package.json','package-lock.json'])await cp(path.join(root,entry),path.join(hub,entry),{recursive:true});
 await mkdir(path.join(hub,'scripts'));for(const entry of ['native-host.mjs','native-server.mjs'])await cp(path.join(root,'scripts',entry),path.join(hub,'scripts',entry));
 const deps=(await run('npm',['ls','--omit=dev','--all','--parseable'])).split('\n').filter(name=>name.startsWith(path.join(root,'node_modules')+path.sep));
 for(const dependency of [...new Set(deps)]){const dest=path.join(hub,path.relative(root,dependency));await mkdir(path.dirname(dest),{recursive:true});await cp(dependency,dest,{recursive:true});}
 const find=async name=>{try{return await run('/usr/bin/which',[name]);}catch{return null;}};
 const codex=await find('codex');let soffice=await find('soffice');
 try{const renderer=JSON.parse(await readFile(path.join(os.homedir(),'Library','Application Support','Automation Hub','runtime','libreoffice','renderer.json'),'utf8'));if(!path.isAbsolute(renderer.destination)||renderer.entryPoint!==path.join(renderer.destination,'Contents','MacOS','soffice'))throw new Error('Invalid private renderer record.');await run('/usr/bin/codesign',['--verify','--strict',renderer.destination]);soffice=renderer.entryPoint;}catch(error){if(error.code!=='ENOENT')throw error;}
 const config={version:1,codex,soffice,executableDirectories:[path.dirname(process.execPath),...[codex,soffice].filter(Boolean).map(name=>path.dirname(name))]};
 await writeFile(path.join(hub,'native-config.json'),JSON.stringify(config,null,2)+'\n');
 await run(path.join(resources,'runtime','bin','node'),['--input-type=module','-e','await import("./server/index.mjs"); console.log("Production module import passed")'],{cwd:hub,env:{HOME:os.homedir(),PATH:'/usr/bin:/bin'}});
 await run('/usr/bin/plutil',['-lint',path.join(contents,'Info.plist')]);
 await run('/usr/bin/codesign',['--force','--sign','-',app]);
 await run('/usr/bin/codesign',['--verify','--strict',app]);
 const files={};async function walk(directory){for(const item of await readdir(directory,{withFileTypes:true})){const file=path.join(directory,item.name);if(item.isDirectory())await walk(file);else if(item.isFile())files[path.relative(app,file)]=sha(await readFile(file));else if(item.isSymbolicLink())throw new Error('Unexpected symlink in native app: '+file);}}await walk(app);
 await mkdir(path.dirname(target),{recursive:true});
 const replacement=await replaceManagedApp(app,target,{backupDirectory:path.join(os.homedir(),'Library','Application Support','Automation Hub','app-versions')});
 const receipt={observedAt:new Date().toISOString(),application:target,bundleIdentifier:'local.nazeeh.automationhub',nodeVersion:process.version,nodeSha256:files['Contents/Resources/runtime/bin/node'],architecture:process.arch,adHocSigned:true,notarized:false,productionDependencies:deps.map(name=>path.relative(root,name)),externalCapabilities:{codex,soffice,browsers:'Existing private version-matched Playwright cache'},replacement,files};
 await mkdir(path.join(root,'docs','native-app'),{recursive:true});await writeFile(path.join(root,'docs','native-app','BUILD_RECEIPT.json'),JSON.stringify(receipt,null,2)+'\n');
 // Only our uniquely created build staging remains here; preserve installed/old apps.
 await rm(build,{recursive:true,force:true});
 console.log(`Built and verified ${target}. Existing data stays in Application Support.`);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
