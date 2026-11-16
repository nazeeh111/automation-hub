import {createHash} from 'node:crypto';
const digest=value=>createHash('sha256').update(value).digest('hex');
const fault=message=>Object.assign(new Error(message),{code:'supporting_document_scope',status:409});
export function supportingControlFingerprint(question){
 if(!question||question.kind!=='document'||question.type!=='file'||typeof question.label!=='string'||!question.label||typeof question.name!=='string'||typeof question.accept!=='string'||typeof question.required!=='boolean'||typeof question.multiple!=='boolean')throw fault('This upload needs the actual employer file-control metadata. Re-read the application form.');
 let source;try{source=new URL(question.sourceUrl);if(!['https:','http:'].includes(source.protocol)||source.username||source.password)throw new Error();}catch{throw fault('This upload has no usable employer control source URL.');}
 source.search='';source.hash='';
 return digest(JSON.stringify({label:question.label,name:question.name,type:'file',accept:question.accept,required:question.required,multiple:question.multiple,sourceUrl:source.toString()}));
}
export function supportingBinding({job,profile,question}){
 if(!job?.id||!job.identity||!job.posting?.sourceHash||!job.packageId||!profile?.id)throw fault('Verify this application, candidate and resume package before attaching supporting files.');
 return {jobId:job.id,jobIdentity:job.identity,candidateId:profile.id,profileRevision:profile.updatedAt||null,profileHash:digest(JSON.stringify(profile)),postingHash:job.posting.sourceHash,packageId:job.packageId,questionHash:supportingControlFingerprint(question)};
}
export function supportingDocumentMatches(document,{job,profile,question}={}){
 try{const expected=supportingBinding({job,profile,question});return Boolean(document?.id&&document.reviewedAt&&document.verified===true&&typeof document.hash==='string'&&/^[a-f0-9]{64}$/.test(document.hash)&&document.binding&&Object.keys(expected).every(key=>document.binding[key]===expected[key]));}catch{return false;}
}
