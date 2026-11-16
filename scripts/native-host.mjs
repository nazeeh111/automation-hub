// Machine-only launcher. The one-time URL is returned through the app's private
// anonymous pipe, never logged, stored in preferences, or placed in arguments.
import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {openExisting,nativeOpen,validateLaunchUrl} from '../server/local-launch.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fault=code=>Object.assign(new Error('The private hub could not open.'),{code});
export async function desktopEnvironment(){
 let config={};try{config=JSON.parse(await readFile(path.join(root,'native-config.json'),'utf8'));}catch(error){if(error.code!=='ENOENT')throw fault('NATIVE_CONFIGURATION');}
 const environment=Object.fromEntries(['HOME','TMPDIR','USER','LOGNAME','LANG','LC_ALL','CODEX_HOME','SSL_CERT_FILE','NODE_EXTRA_CA_CERTS','HUB_DATA_DIR','HUB_PORT'].filter(key=>process.env[key]).map(key=>[key,process.env[key]]));
 const directories=[path.dirname(process.execPath),...(config.executableDirectories||[]),path.join(homedir(),'.local','bin'),'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'];
 environment.PATH=[...new Set(directories)].join(path.delimiter);
 for(const [key,value] of Object.entries({HUB_CODEX_BIN:config.codex,HUB_SOFFICE_BIN:config.soffice}))if(typeof value==='string'&&path.isAbsolute(value))environment[key]=value;
 return environment;
}
export async function ensureDesktopHub({directory=process.env.HUB_DATA_DIR||path.join(homedir(),'Library','Application Support','Automation Hub'),timeoutMs=15000,start,open=openExisting}={}){
 let url;const attach=()=>open({directory,openBrowser:async value=>{url=validateLaunchUrl(value);}});
 if((await attach()).opened)return {url,started:false};
 // Existing private-launch denials propagate above. Only an absent/refused,
 // correctly owned endpoint is allowed to attempt normal worker acquisition.
 const child=start?await start():spawn(process.execPath,[path.join(root,'scripts','native-server.mjs')],{cwd:root,env:await desktopEnvironment(),stdio:'ignore',detached:true});
 let failure;child.once?.('error',()=>{failure=true;});child.unref?.();
 const until=Date.now()+timeoutMs;
 while(Date.now()<until){if(failure)throw fault('NATIVE_BACKEND_START');await pause(100);if((await attach()).opened)return {url,started:true};}
 throw fault('NATIVE_BACKEND_TIMEOUT');
}
export async function launchDesktop(mode,{ensure=ensureDesktopHub,openBrowser=nativeOpen}={}){
 if(!['window','browser','browser-connections'].includes(mode))throw fault('NATIVE_OPERATION');
 const result=await ensure();
 if(mode==='window')return {url:validateLaunchUrl(result.url)};
 const destination=new URL(validateLaunchUrl(result.url));if(mode==='browser-connections')destination.hash='connections';
 await openBrowser(destination.toString());return {opened:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.stdout.write(JSON.stringify(await launchDesktop(process.argv[2]||'window'))+'\n');}
 catch(error){const code=/^[A-Z0-9_]{1,60}$/.test(error.code||'')?error.code:'NATIVE_LAUNCH_REFUSED';process.stderr.write(code+'\n');process.exitCode=1;}
}
