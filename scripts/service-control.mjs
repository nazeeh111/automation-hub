import path from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {stopExisting} from '../server/local-launch.mjs';
import {startupMessage,validateStartupEnvironment,startupFault} from '../server/startup-errors.mjs';

export async function controlService(operation,{directory=process.env.HUB_DATA_DIR||path.join(homedir(),'Library','Application Support','Automation Hub'),stop=stopExisting}={}){
 if(operation!=='stop')throw startupFault('LOCAL_LAUNCH_REFUSED');
 return stop({directory});
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  validateStartupEnvironment({...(process.env.HUB_DATA_DIR!==undefined?{HUB_DATA_DIR:process.env.HUB_DATA_DIR}:{})});
  await controlService(process.argv[2]);
  console.log('The identified background worker has stopped. Its process exited and its private control entries are gone. Preserve the current runtime bytes before restoring a complete backup.');
 }catch(error){console.error(startupMessage(error));process.exitCode=1;}
}
