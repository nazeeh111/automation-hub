import {AppVault} from './vault.mjs';
import {EmployerAccountAdapter} from './account-adapter.mjs';
import {InboxService} from './inbox.mjs';
import {OutcomeService} from './outcomes.mjs';
import {GmailOAuth} from './gmail-oauth.mjs';
import {preciseDeadline} from './posting-requirements.mjs';
const now=()=>new Date().toISOString();
const fault=message=>Object.assign(new Error(message),{status:409,code:'connection_setup'});
const actions=new Set(['vaultSetup','vaultUnlock','vaultLock','saveAccountSettings','saveExistingAccount','accountVerification','configureInbox','probeInbox','pollInbox','acceptInboxProposal','dismissInboxProposal','configureGmailClient','beginGmailAuthorization']);

// One interface owns connection authority, secret handling and observed messages.
// The HTTP layer never receives decrypted vault entries or raw inbox bodies.
export class InternshipConnections{
 constructor({store,directory,demo=false,inboxRunner=null,inboxCommand,oauthFetcher}={}){
  Object.assign(this,{store,directory,demo});this.vault=new AppVault({directory});
  this.gmailOAuth=new GmailOAuth({store,vault:this.vault,...(oauthFetcher?{fetcher:oauthFetcher}:{})});
  this.inbox=new InboxService({store,vault:this.vault,directory,runner:inboxRunner,command:inboxCommand});
  const nativeRunner=this.inbox.runner;this.inbox.runner=async(method,params)=>(await this.gmailOAuth.status()).configured?this.gmailOAuth.runner(method,params):nativeRunner(method,params);
  this.accounts=new EmployerAccountAdapter({store,vault:this.vault,verificationResolver:request=>this.inbox.getVerification(request)});
  this.outcomes=new OutcomeService({store,demo});this.closed=false;this.scanning=null;
 }
 hasAction(name){return actions.has(name);}
 activeVerificationRequests({now=Date.now()}={}){return this.store.list('verification_request').filter(request=>request.state==='pending'&&preciseDeadline(request.expiresAt)&&Date.parse(request.expiresAt)>now).map(request=>({id:request.id,accountId:request.accountId,tenant:request.tenant,recipient:request.recipient,purpose:request.purpose,expiresAt:request.expiresAt,state:request.state}));}
 async snapshot(){const gmailOAuth=await this.gmailOAuth.status(),inbox=await this.inbox.readiness();
  if(gmailOAuth.configured){inbox.status=gmailOAuth.authorized&&inbox.verified?'ready':'missing';inbox.detail=gmailOAuth.locked?'Unlock the app vault to use protected Gmail.':gmailOAuth.authorized?(inbox.verified?'Protected read-only Gmail is connected. Employer messages remain bound to their exact application.':'Check the authorized mailbox before reading employer messages.'):gmailOAuth.detail;}
  return {vault:await this.vault.status(),gmailOAuth,inbox,verificationRequests:this.activeVerificationRequests(),inboxProposals:this.store.list('inbox_proposal').filter(p=>p.state==='open'),accountSettings:this.store.list('account_config')};
 }
 async readiness(){return [await this.accounts.readiness(),await this.inbox.readiness()];}
 start(){if(this.timer)return;this.timer=setInterval(()=>{if(!this.closed)this.scan({automatic:true}).catch(()=>{});},60000);this.timer.unref?.();}
 async close(){this.closed=true;clearInterval(this.timer);if(this.scanning)await this.scanning.catch(()=>{});this.gmailOAuth.lock();await this.vault.close();}
 async action(name,body={},metadata={}){
  if(!this.hasAction(name))return null;
  if(name==='configureGmailClient'){if(this.demo)throw fault('Real Gmail authorization is unavailable in the fixture workspace.');try{return await this.gmailOAuth.configureClient(body);}finally{body.clientSecret='';}}
  if(name==='beginGmailAuthorization'){if(this.demo)throw fault('Real Gmail authorization is unavailable in the fixture workspace.');return this.gmailOAuth.start({email:this.store.get('connection','inbox')?.email,baseUrl:metadata.baseUrl,sessionId:metadata.sessionId});}
  if(['vaultSetup','vaultUnlock','vaultLock'].includes(name)){
   try{if(name==='vaultSetup')await this.vault.setup(body.passphrase);else if(name==='vaultUnlock')await this.vault.unlock(body.passphrase);else {this.gmailOAuth.lock();this.vault.lock();}
    if(name!=='vaultLock')await this.accounts.resumeLocked?.();const status=await this.vault.status();this.store.event(null,name==='vaultLock'?'vault_locked':'vault_unlocked',{configured:status.configured});return {vault:status};
   }finally{body.passphrase='';}
  }
  if(name==='saveAccountSettings')return this.accounts.saveSettings(body);
  if(name==='saveExistingAccount'){try{return await this.accounts.saveExisting({...body,candidateId:'main'});}finally{body.password='';}}
  if(name==='accountVerification'){try{return await this.accounts.provideVerification(body);}finally{body.code='';body.link='';}}
  if(name==='configureInbox'){
   if(this.demo&&body.enabled)throw fault('Real inbox access is unavailable in the fixture workspace.');
   const saved=await this.inbox.configure(body);const connection=this.store.get('connection','inbox');
   if(connection)this.store.put('connection',{...connection,autoTrack:body.enabled===true&&body.autoTrack===true});return saved;
  }
  if(name==='probeInbox'){if(this.demo)throw fault('Real inbox access is unavailable in the fixture workspace.');return this.inbox.probe(body);}
  if(name==='pollInbox')return this.scan({automatic:false});
  if(name==='acceptInboxProposal')return this.outcomes.accept(body.proposalId,{automatic:false});
  if(name==='dismissInboxProposal')return this.outcomes.dismiss(body.proposalId);
 }
 async scan({automatic=false}={}){
  const connection=this.store.get('connection','inbox');
  if(this.closed||this.demo||!connection?.enabled||!connection.verified)return {checkedJobs:0,skipped:true,reason:'A verified, enabled application inbox is required.'};
  const backoff=this.store.get('inbox_poll_state','main');if(automatic&&Date.parse(backoff?.nextCheckAt||'')>Date.now())return {checkedJobs:0,skipped:true,reason:'The inbox check is waiting for its bounded retry window.'};
  if(this.scanning)return this.scanning;
  this.scanning=(async()=>{
   const profile=this.store.get('profile','main');const result=await this.inbox.pollOutcomes(this.store.list('job'),profile);const current=this.store.get('connection','inbox');
   if(!current?.enabled||current.email!==connection.email||current.updatedAt!==connection.updatedAt)return {...result,accepted:0,reason:'Inbox settings changed during this check.'};
   let accepted=0;
   if(current.autoTrack)for(const p of result.proposals||[]){if(p.confidence!=='matched'||p.state!=='open')continue;try{const applied=this.outcomes.accept(p.id,{automatic:true});if(!applied.replayed)accepted++;}catch{}}
   this.store.put('inbox_poll_state',{id:'main',failures:0,nextCheckAt:null,lastCheckedAt:now()});this.store.event(null,'inbox_checked',{checkedJobs:result.checkedJobs||0,proposals:(result.proposals||[]).length,accepted,automatic});return {...result,accepted};
  })();try{return await this.scanning;}catch(error){const failures=(this.store.get('inbox_poll_state','main')?.failures||0)+1;const live=this.store.get('connection','inbox');this.store.put('inbox_poll_state',{id:'main',failures,lastErrorCode:error.code||'INBOX_UNAVAILABLE',lastCheckedAt:now(),nextCheckAt:new Date(Date.now()+Math.min(15*60000,60000*2**Math.min(failures,4))).toISOString()});if(live&&live.revision===connection.revision)this.store.put('connection',{...live,verified:failures>=3?false:live.verified,lastErrorCode:error.code||'INBOX_UNAVAILABLE',lastErrorAt:now()});throw error;}finally{this.scanning=null;}
 }
 async prior(job,profile){
  const c=this.store.get('connection','inbox');if(this.demo||!c?.enabled||!c.verified)return {status:'local_history_only'};
  if(typeof this.inbox.findPriorSubmission!=='function')return {status:'inbox_not_checked'};
  try{const result=await this.inbox.findPriorSubmission(job,profile);const proposal=result?.proposal||result;
   if(!proposal?.id||proposal.confidence!=='matched')return {status:'inbox_checked'};
   const current=this.store.get('connection','inbox');if(!current?.enabled||current.updatedAt!==c.updatedAt||current.email!==c.email)return {status:'inbox_settings_changed'};
   if(current.autoTrack!==true)return {alreadyApplied:true,status:'matching_receipt_pending_review',proposalId:proposal.id};
   this.outcomes.accept(proposal.id,{automatic:true});return {alreadyApplied:true,status:'matching_employer_receipt',proposalId:proposal.id};
  }catch(error){if(error.code?.startsWith('INBOX_'))return {status:'inbox_unavailable'};throw error;}
 }
}
