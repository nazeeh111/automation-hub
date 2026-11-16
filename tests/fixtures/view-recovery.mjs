import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {postingJob} from './posting.mjs';

export async function recoveryFixture(createHub) {
  const directory=await mkdtemp(path.join(tmpdir(),'hub-view-recovery-'));
  const hub=await createHub({directory,port:0,open:false,modelRunner:async()=>{throw new Error('Synthetic fixture forbids inference');},discoveryOptions:{fetcher:async()=>{throw new Error('Synthetic fixture forbids source reads');}}});
  const context=hub.context(false);
  await context.engine.stop({releaseWorker:false});
  const store=context.store;
  store.put('profile',{id:'main',fullName:'Synthetic Candidate',email:'candidate@example.invalid'});
  await context.resumes.import([{name:'Retained source.md',content:Buffer.from('# Synthetic Candidate\n\n## Projects\n### Controlled simulation\n- Built a simulated sensor prototype with Python.\n- Measured twelve controlled cases.\n').toString('base64')}]);
  const job=postingJob(store,{id:'recovery-role',title:'Controls engineering intern',employer:'Synthetic Recovery Lab'});
  const packet=await context.resumes.select(job,store.list('resume')[0].id);
  store.put('job',{...store.get('job',job.id),packageId:packet.id,state:'needs_you'});
  store.put('package',{...packet,explanation:{synthetic:'Unexpected optional-view render input'}});
  return {hub,store,packet,job,async close(){await hub.close();await rm(directory,{recursive:true,force:true});}};
}
