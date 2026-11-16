import path from 'node:path';
import {startupMessage,validateStartupEnvironment} from '../server/startup-errors.mjs';
import {homedir} from 'node:os';
import {openExisting} from '../server/local-launch.mjs';
const directory=process.env.HUB_DATA_DIR||path.join(homedir(),'Library','Application Support','Automation Hub');
try {
 validateStartupEnvironment();
 const existing=await openExisting({directory});
 if(!existing.opened){
  const {createHub}=await import('../server/index.mjs');
  const hub=await createHub({directory,open:true,enableControl:true});
  console.log('Automation hub is running. Its private browser session is open.');
  let closing=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;await hub.close();process.exit(0)});
 }
}catch(error){console.error(startupMessage(error));process.exitCode=1;}
