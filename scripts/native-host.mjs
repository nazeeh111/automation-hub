// Machine-only launcher. Private launch URLs travel only through the app pipe.
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {openExisting,stopExisting,nativeOpen,validateLaunchUrl} from '../server/local-launch.mjs';
import {absoluteSetting,validateStartupEnvironment,startupCode,startupFault} from '../server/startup-errors.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export function resolveDesktopConfiguration({environment=process.env,config={}}={}){
 validateStartupEnvironment(environment);
 if(!config||typeof config!=='object'||Array.isArray(config))throw startupFault('NATIVE_CONFIGURATION');
 const selected={};
 for(const [key,field] of [['HUB_CODEX_BIN','codex'],['HUB_SOFFICE_BIN','soffice'],['PLAYWRIGHT_BROWSERS_PATH','browsers']]){
  const value=environment[key]!==undefined?environment[key]:config[field];
  if(value!==null&&value!==undefined)selected[key]=absoluteSetting(value);
 }
 return selected;
}
export async function desktopEnvironment({environment=process.env,config}={}){
 if(config===undefined){try{config=JSON.parse(await readFile(path.join(root,'native-config.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw startupFault('NATIVE_CONFIGURATION');config={};}}
 const selected=resolveDesktopConfiguration({environment,config});
 const result=Object.fromEntries(['HOME','TMPDIR','USER','LOGNAME','LANG','LC_ALL','CODEX_HOME','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS','HUB_DATA_DIR','HUB_PORT'].filter(key=>environment[key]).map(key=>[key,environment[key]]));
 if(config.executableDirectories!==undefined&&(!Array.isArray(config.executableDirectories)||config.executableDirectories.length>32))throw startupFault('NATIVE_CONFIGURATION');
 const directories=[path.dirname(process.execPath),...(config.executableDirectories||[]).map(absoluteSetting),path.join(homedir(),'.local','bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'];
 result.PATH=[...new Set(directories)].join(path.delimiter);
 return {...result,...selected};
}
export async function ensureDesktopHub({directory=process.env.HUB_DATA_DIR||path.join(homedir(),'Library','Application Support','Automation Hub'),timeoutMs=15000,start,open=openExisting}={}){
 let url;const attach=()=>open({directory,openBrowser:async value=>{url=validateLaunchUrl(value);}});
 if((await attach()).opened)return {url,started:false};
 // A denial propagates; only identified absent/refused endpoints permit acquisition.
 const child=start?await start():spawn(process.execPath,[path.join(root,'scripts','native-server.mjs')],{cwd:root,env:await desktopEnvironment({environment:{...process.env,HUB_DATA_DIR:directory}}),stdio:['ignore','ignore','ignore','ipc'],detached:true});
 let failure;
 const failed=()=>{failure ||= 'NATIVE_BACKEND_START';};
 const message=value=>{if(value&&Object.keys(value).length===2&&value.type==='startup-error'&&typeof value.code==='string'&&startupCode({code:value.code})===value.code)failure=value.code;};
 child.once?.('error',failed);child.once?.('exit',failed);child.on?.('message',message);child.unref?.();child.channel?.unref();
 try{
  const until=Date.now()+timeoutMs;
  while(Date.now()<until){if(failure)throw startupFault(failure);if((await attach()).opened)return {url,started:true};await pause(50);}
  if(failure)throw startupFault(failure);throw startupFault('NATIVE_BACKEND_TIMEOUT');
 }finally{
  child.removeListener?.('error',failed);child.removeListener?.('exit',failed);child.removeListener?.('message',message);
  // Startup diagnostics are bounded to the acquisition window. A successful
  // detached worker never retains a dependency on its opening helper.
  child.on?.('error',()=>{});
  try{if(child.connected)child.disconnect();}catch{}
 }
}
export async function launchDesktop(mode,{ensure=ensureDesktopHub,openBrowser=nativeOpen,stop=stopExisting}={}){
 if(mode==='shutdown')return stop({directory:process.env.HUB_DATA_DIR||path.join(homedir(),'Library','Application Support','Automation Hub')});
 if(!['window','browser','browser-connections'].includes(mode))throw startupFault('NATIVE_OPERATION');
 const result=await ensure();
 if(mode==='window')return {url:validateLaunchUrl(result.url)};
 const destination=new URL(validateLaunchUrl(result.url));if(mode==='browser-connections')destination.hash='connections';
 await openBrowser(destination.toString());return {opened:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.stdout.write(JSON.stringify(await launchDesktop(process.argv[2]||'window'))+'\n');}
 catch(error){process.stderr.write(startupCode(error)+'\n');process.exitCode=1;}
}
