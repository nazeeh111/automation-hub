import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

export function tenantKey(raw) {
  const url=new URL(raw);
  if (!['https:','http:'].includes(url.protocol)||url.username||url.password) throw new Error('Unsupported account destination');
  const host=url.hostname.toLowerCase();
  const parts=url.pathname.split('/').filter(Boolean);
  if(host.endsWith('.myworkdaysite.com')) {
    const recruiting=parts.findIndex(p=>p.toLowerCase()==='recruiting');
    if(recruiting<0||parts.length<recruiting+3) throw new Error('Workday tenant identity is incomplete');
    return `${host}/recruiting/${parts[recruiting+1]}/${parts[recruiting+2]}`;
  }
  if(host.endsWith('.myworkdayjobs.com')) return host;
  if(host==='jobs.lever.co'||host==='jobs.eu.lever.co'||host==='boards.greenhouse.io'||host==='job-boards.greenhouse.io'||host==='job-boards.eu.greenhouse.io') {
    if(!parts[0]) throw new Error('Employer tenant is missing');
    return `${host}/${parts[0]}`;
  }
  return host;
}
export function accountIdentity(url,candidateId) {
  if(!candidateId) throw new Error('Candidate identity is missing');
  return createHash('sha256').update(`${tenantKey(url)}\0${candidateId}`).digest('hex');
}
export function newPassword() { return `${randomBytes(24).toString('base64url')}!aA7`; }
// Caller supplies an app-scoped key after explicit setup. No host credential store is accessed.
export function encryptSecret(secret,key,aad) {
  if(!Buffer.isBuffer(key)||key.length!==32||!aad) throw new Error('A 32-byte app key and account binding are required');
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',key,iv); cipher.setAAD(Buffer.from(aad));
  const content=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);
  return {algorithm:'aes-256-gcm',iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),content:content.toString('base64')};
}
export function decryptSecret(record,key,aad) {
  const decipher=createDecipheriv('aes-256-gcm',key,Buffer.from(record.iv,'base64')); decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(record.tag,'base64'));
  return Buffer.concat([decipher.update(Buffer.from(record.content,'base64')),decipher.final()]).toString('utf8');
}
export function matchVerification(request,message,currentTime=Date.now()) {
  if(!request?.tenant||!request.recipient||!request.purpose||!request.createdAt||!request.expiresAt) throw new Error('Verification request is incomplete');
  if(!request.allowedHosts?.length||!request.expectedSenders?.length) throw new Error('Verification sender and destination must be configured');
  const sent=Date.parse(message.receivedAt),start=Date.parse(request.createdAt),end=Date.parse(request.expiresAt);
  if(!Number.isFinite(sent)||!Number.isFinite(start)||!Number.isFinite(end)||currentTime>end||sent<start||sent>end) throw new Error('Verification message is stale or expired');
  if(String(message.recipient).toLowerCase()!==String(request.recipient).toLowerCase()) throw new Error('Verification recipient does not match');
  if(!request.expectedSenders.map(v=>v.toLowerCase()).includes(String(message.sender).toLowerCase())) throw new Error('Verification sender does not match');
  if(message.purpose!==request.purpose||message.tenant!==request.tenant||message.requestId!==request.id) throw new Error('Verification purpose, request or employer does not match');
  const codes=[...new Set(message.codes||[])];
  if(codes.length>1) throw new Error('Verification code is ambiguous');
  if(message.link) {
    const destination=new URL(message.link);
    if(destination.protocol!=='https:'||destination.username||destination.password||!request.allowedHosts.includes(destination.hostname)||tenantKey(message.link)!==request.tenant) throw new Error('Verification destination does not match the employer');
  }
  if(!message.link&&codes.length!==1) throw new Error('Verification message has no usable result');
  return {requestId:request.id,code:codes[0]||null,link:message.link||null};
}
