import {createHash} from 'node:crypto';

const ordered=value=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
export const reasoningDigest=value=>createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
const held=resume=>resume?.renderStatus==='needs_review'||resume?.renderCode==='render_integrity_review';

// A clarification belongs to the exact candidate, source and usable comparison
// corpus. Read/check timestamps are not changes to the employer's retained text.
export function reasoningContext(store,job){
 const resumes=store.list('resume'),excluded=new Set(resumes.filter(held).map(resume=>resume.id));
 const facts=store.list('fact').filter(fact=>!fact.suppressed).map(fact=>({...fact,sources:(fact.sources||[]).filter(source=>!excluded.has(source.resumeId))})).filter(fact=>fact.sources.length);
 const posting={...(job.posting||{})};delete posting.observedAt;delete posting.fetchedAt;
 for(const key of Object.keys(posting))if(Array.isArray(posting[key])&&!posting[key].length)delete posting[key];
 const observation=job.postingObservationId&&store.get('postingObservation',job.postingObservationId);
 return {version:1,contextHash:reasoningDigest({workspace:store.directory,jobId:job.id,identity:job.identity||null,url:job.url||null,title:job.title||null,employer:job.employer||null,posting,observationId:job.postingObservationId||null,latestObservationId:job.latestPostingObservationId||null,contentHash:observation?.contentHash||null,profile:store.get('profile','main'),resumes:resumes.filter(resume=>!held(resume)),facts})};
}
export function reasoningQuestionHash(decision){return reasoningDigest({question:decision.question,reason:decision.reason||'',options:decision.options||[]});}
export function reasoningDecisionCurrent(store,decision,job=store.get('job',decision?.jobId)){
 const binding=decision?.reasoningBinding;
 return Boolean(job&&decision?.type==='missing_fact'&&decision.state==='open'&&binding?.version===1&&binding.contextHash===reasoningContext(store,job).contextHash&&binding.questionHash===reasoningQuestionHash(decision));
}
export function currentReasoningAnswers(job,context){
 const answers={};
 for(const [question,binding] of Object.entries(job.reasoningAnswerBindings||{}))if(binding?.version===1&&binding.contextHash===context.contextHash&&typeof binding.questionHash==='string'&&Object.hasOwn(job.reasoningAnswers||{},question)&&binding.answerHash===reasoningDigest(job.reasoningAnswers[question]))answers[question]=job.reasoningAnswers[question];
 return answers;
}
