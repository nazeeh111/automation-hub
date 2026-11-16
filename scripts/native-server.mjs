import {startupCode,validateStartupEnvironment} from '../server/startup-errors.mjs';
// A user-started worker, not a daemon/login item. Quit leaves it running;
// explicit owned shutdown drains ordinary hub.close(), without OS signals.
try{
 validateStartupEnvironment();
 const {createHub}=await import('../server/index.mjs');
 const hub=await createHub({open:false,enableControl:true});
 let closing=false;
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;try{await hub.close();process.exit(0);}catch{process.exit(1);}});
}catch(error){
 const code=startupCode(error);
 if(process.send&&process.connected)await new Promise(resolve=>process.send({type:'startup-error',code},()=>resolve()));
 else process.stderr.write(code+'\n');
 process.exitCode=1;
}
