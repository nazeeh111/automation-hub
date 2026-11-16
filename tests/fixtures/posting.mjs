import {createHash} from 'node:crypto';
import {PostingObservations} from '../../server/posting-observations.mjs';

// Explicit synthetic source context for tests whose subject is another contract.
// This is fixture arrangement only; production never invents a legacy binding.
export function postingJob(store,job){
 const current=store.get('job',job.id),base={identity:`fixture:${job.id}`,url:`https://jobs.lever.co/synthetic/${encodeURIComponent(job.id)}`,title:'Synthetic engineering intern',employer:'Synthetic employer',state:'imported',revision:0,...current,...job};
 const text=job.posting?.text||current?.posting?.text||'Synthetic engineering internship. Python experience is preferred.';
 const posting={title:base.title,employer:base.employer,open:true,text,requirements:[],sourceUrl:base.url,sourceHash:createHash('sha256').update(text).digest('hex'),...current?.posting,...job.posting};
 return store.put('job',{...base,posting});
}
export function bindPreparedPosting(store,job,pkg){
 const source=store.get('job',job.id)||job,service=new PostingObservations({store}),observation=service.record(source,source.posting,{adopt:true,reason:'synthetic_fixture'});
 return {...pkg,postingBinding:service.binding(source,observation)};
}
