import {createHub} from '../server/index.mjs';
// A user-started background worker, not a daemon/login item. It intentionally
// survives window/app close so quitting the window does not interrupt a campaign.
try{
 const hub=await createHub({open:false,enableControl:true});
 let closing=false;
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(closing)return;closing=true;try{await hub.close();process.exit(0);}catch{process.exit(1);}});
}catch{process.exitCode=1;}
