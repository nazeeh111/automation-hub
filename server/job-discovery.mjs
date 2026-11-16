import {createHash} from 'node:crypto';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import https from 'node:https';
import {privateAddress} from './adapters.mjs';

// Employer-feed discovery is a read-only, manual operation. It never writes the
// application queue, enables a campaign, reads a credential or submits a form.
export const DISCOVERY_LIMITS=Object.freeze({sources:50,jobsPerRefresh:1000,retainedPerSource:3000,retainedTotal:10000,pageSize:100,pages:10,responseBytes:4*1024*1024,totalBytes:8*1024*1024,timeoutMs:15000,minIntervalMs:30000,staleMs:24*60*60*1000});
// Optional starting points, individually observed by a separate read-only probe.
// These are suggestions, not registered connections or current opening claims.
export const DISCOVERY_SUGGESTIONS=Object.freeze([
 Object.freeze({label:'Nex',boardUrl:'https://job-boards.greenhouse.io/nex',provider:'greenhouse',observedAt:'2026-11-15',note:'Games and engineering roles; observed an engineering internship.'}),
 Object.freeze({label:'Rocket Lab',boardUrl:'https://job-boards.greenhouse.io/rocketlab',provider:'greenhouse',observedAt:'2026-11-15',note:'Aerospace and engineering roles; a large board may use metadata-only descriptions.'})
]);
const fault=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text=(value,max=250)=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max):'';
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value)&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const description=value=>text(value,12000).replace(/<[^>]*>/g,' ').replace(/&(?:lt|gt|amp|quot|#39);/g,match=>({'&lt;':'<','&gt;':'>','&amp;':'&','&quot;':'"','&#39;':"'"}[match])).replace(/\s+/g,' ').trim();
const token=/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const usStates='AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC';
const stateNames='Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming|District of Columbia';
// Deliberately finite country cues. Unrecognized values remain unknown. These
// are location evidence, never eligibility, nationality or work-authorization.
const nonUsCodes=new Set('AE AR AT AU BE BG BH BR CA CH CL CN CO CR CY CZ DE DK DO DZ EC EE EG ES FI FR GB GE GH GR HK HR HU ID IE IL IN IQ IS IT JM JO JP KE KH KR KW KZ LB LK LT LU LV MA MC MD ME MK MM MN MO MT MU MX MY NG NL NO NP NZ OM PA PE PH PK PL PT QA RO RS RU SA SE SG SI SK TH TN TR TW UA UG UY UZ VN ZA ZM ZW'.split(' '));
const countryNames=new Intl.DisplayNames(['en'],{type:'region'});
const nonUsNames=[...nonUsCodes].filter(code=>code!=='GE').map(code=>countryNames.of(code)).concat(['United Kingdom','South Korea','Hong Kong','Taiwan']);
const cityStateCode=new RegExp(`(?:^|[;|/])\\s*[\\p{L}][\\p{L}\\p{N} .'-]{1,100},\\s*(?:${usStates.split(' ').join('|')})(?=$|[\\s,;(])`,'u');
const cityStateName=new RegExp(`(?:^|[;|/])\\s*[\\p{L}][\\p{L}\\p{N} .'-]{1,100},\\s*(?:${stateNames})(?=$|[\\s,;(])`,'iu');
const usCountry=value=>/^(?:US|USA|U\.?S\.?A?\.?|United States(?: of America)?)$/i.test(value);
const escaped=value=>value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const nonUsLocation=new RegExp(`(?:^|[\\s,;(/|])(?:${nonUsNames.map(escaped).join('|')})(?=$|[\\s,;)/|])`,'iu');
export function discoveryLocationScope(location,country=''){
 const label=text(location,500),reportedCountry=text(country,100),code=reportedCountry.toUpperCase();
 const structured=usCountry(reportedCountry)?'us':nonUsCodes.has(code)||nonUsNames.some(name=>name.toLocaleLowerCase()===reportedCountry.toLocaleLowerCase())?'outside_us':'unknown';
 const explicitUs=/(?:^|[\s,;(/|])United States(?: of America)?(?=$|[\s,;)/|])/i.test(label)||/(?:^|[\s,;(/|])(?:USA|US|U\.S\.(?:A\.?)?)(?=$|[\s,;)/|])/.test(label);
 const us=explicitUs||cityStateCode.test(label)||cityStateName.test(label),outside=nonUsLocation.test(label);
 const segments=label.split(/[;|/]/).map(value=>value.trim()).filter(value=>value&&!/^(?:remote|hybrid|on[ -]?site)$/i.test(value));
 if(structured==='unknown'&&segments.length>1){const scopes=segments.map(value=>discoveryLocationScope(value));if(new Set(scopes).size!==1||scopes[0]==='unknown')return 'unknown';}
 const fromLabel=us&&outside?'unknown':us?'us':outside?'outside_us':'unknown';
 if(us&&outside||structured==='us'&&outside||structured==='outside_us'&&us)return 'unknown';
 return structured!=='unknown'?structured:fromLabel;
}

export function parseDiscoverySource(raw){
 if(typeof raw!=='string'||raw.length>500||!/^https:\/\//i.test(raw))throw fault('DISCOVERY_SOURCE','Use a public Greenhouse or Lever employer board URL.',400);
 let url;try{url=new URL(raw);}catch{throw fault('DISCOVERY_SOURCE','The employer board URL is invalid.',400);}
 if(url.username||url.password||url.search||url.hash||url.port&&url.port!=='443')throw fault('DISCOVERY_SOURCE','Use the employer board URL without credentials, queries, fragments or a custom port.',400);
 const parts=url.pathname.split('/').filter(Boolean);let provider,region='us',board;
 if(['boards.greenhouse.io','job-boards.greenhouse.io','job-boards.eu.greenhouse.io'].includes(url.hostname)&&parts.length===1){provider='greenhouse';region=url.hostname==='job-boards.eu.greenhouse.io'?'eu':'us';board=parts[0];}
 else if(['jobs.lever.co','jobs.eu.lever.co'].includes(url.hostname)&&parts.length===1){provider='lever';region=url.hostname==='jobs.eu.lever.co'?'eu':'us';board=parts[0];}
 else throw fault('DISCOVERY_SOURCE','Only exact Greenhouse and Lever employer board URLs are supported. Use the board, not a single job or API URL.',400);
 if(!token.test(board))throw fault('DISCOVERY_SOURCE','The employer board identifier is unsupported.',400);
 const boardUrl=`https://${provider==='greenhouse'?(region==='eu'?'job-boards.eu.greenhouse.io':'job-boards.greenhouse.io'):region==='eu'?'jobs.eu.lever.co':'jobs.lever.co'}/${board}`;
 return {id:`${provider}:${region}:${board}`,provider,region,board,boardUrl};
}
function route(source,page=0,metadataOnly=false){
 if(source.provider==='greenhouse')return `https://boards-api.greenhouse.io/v1/boards/${source.board}/jobs${metadataOnly?'':'?content=true'}`;
 return `https://${source.region==='eu'?'api.eu.lever.co':'api.lever.co'}/v0/postings/${source.board}?mode=json&skip=${page*DISCOVERY_LIMITS.pageSize}&limit=${DISCOVERY_LIMITS.pageSize}`;
}
function nativeFetcher(url,{headers,signal,lookup:connectionLookup}){
 return new Promise((resolve,reject)=>{
  const request=https.request(url,{method:'GET',headers,signal,lookup:connectionLookup,agent:false,rejectUnauthorized:true,autoSelectFamily:false},response=>resolve({status:response.statusCode,headers:response.headers,body:response,url,redirected:false}));
  request.once('error',()=>reject(fault('DISCOVERY_UNAVAILABLE','The public employer feed could not be reached securely.')));request.end();
 });
}
function publicLink(raw){
 if(typeof raw!=='string'||raw.length>2000)return null;let url;try{url=new URL(raw);}catch{return null;}
 if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.hostname==='localhost'||url.hostname.endsWith('.local')||url.hostname.endsWith('.localhost')||url.hostname==='metadata.google.internal'||isIP(url.hostname.replace(/^\[|\]$/g,''))&&privateAddress(url.hostname))return null;
 return url.toString();
}
function candidate(source,row){
 if(!row||typeof row!=='object'||Array.isArray(row))throw fault('DISCOVERY_RESPONSE','The public employer feed contains an invalid posting.');
 const greenhouse=source.provider==='greenhouse',externalId=greenhouse?(Number.isSafeInteger(row.id)&&row.id>0?String(row.id):''):(typeof row.id==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(row.id)?row.id:'');
 const title=text(greenhouse?row.title:row.text,500);if(!externalId||!title)throw fault('DISCOVERY_RESPONSE','A public posting is missing its stable identity or title.');
 const canonicalUrl=greenhouse?`${source.boardUrl}/jobs/${externalId}`:`${source.boardUrl}/${externalId}`;
 const url=publicLink(greenhouse?row.absolute_url:row.hostedUrl);if(!url)throw fault('DISCOVERY_RESPONSE','A public posting has an unsafe or missing destination URL.');
 const target=new URL(url),expected=new URL(canonicalUrl);
 const supported=greenhouse?(source.region==='eu'?target.hostname==='job-boards.eu.greenhouse.io':['boards.greenhouse.io','job-boards.greenhouse.io'].includes(target.hostname))&&target.pathname===expected.pathname:target.hostname===expected.hostname&&target.pathname===expected.pathname;
 const location=text(greenhouse?row.location?.name:row.categories?.location,500),country=text(greenhouse?row.location?.country:row.country,100);
 return {id:`${source.id}:${externalId}`,sourceId:source.id,externalId,provider:source.provider,region:source.region,company:text(row.company_name)||source.label,title,location,country,locationScope:discoveryLocationScope(location,country),department:text(greenhouse?row.departments?.map(item=>text(item?.name)).filter(Boolean).join(', '):row.categories?.department||row.categories?.team,500),employmentType:text(greenhouse?'':row.categories?.commitment),workplaceType:text(greenhouse?'':row.workplaceType),description:description(greenhouse?row.content:[row.descriptionPlain,row.additionalPlain,...(Array.isArray(row.lists)?row.lists.map(item=>`${text(item?.text)} ${description(item?.content)}`):[])].filter(Boolean).join(' ')),url,canonicalUrl,postedAt:timestamp(greenhouse?row.first_published:null),sourceUpdatedAt:timestamp(greenhouse?row.updated_at:null),supportStatus:supported?'portal_review_required':'external_portal',supportDetail:supported?'A supported portal family; actual questions, permissions and employer receipts still require verification.':'The feed links to a custom or unsupported application portal. Keep it visible for manual review.'};
}
async function boundedJSON(response,budget){
 const length=Number(response.headers?.get?.('content-length')??response.headers?.['content-length']);
 if(Number.isFinite(length)&&length>DISCOVERY_LIMITS.responseBytes){response.body?.destroy?.();await response.body?.cancel?.().catch(()=>{});throw fault('DISCOVERY_RESPONSE_LIMIT','The employer feed exceeded its bounded response size.');}
 if(!response.body||typeof response.body[Symbol.asyncIterator]!=='function')throw fault('DISCOVERY_RESPONSE','The public feed returned no readable JSON body.');
 let bytes=0;const chunks=[];try{for await(const chunk of response.body){const value=Buffer.from(chunk);bytes+=value.length;budget.bytes+=value.length;if(bytes>DISCOVERY_LIMITS.responseBytes||budget.bytes>DISCOVERY_LIMITS.totalBytes){response.body.destroy?.();throw fault('DISCOVERY_RESPONSE_LIMIT','The employer feed exceeded its bounded read size.');}chunks.push(value);}return JSON.parse(Buffer.concat(chunks,bytes).toString('utf8'));}catch(error){if(error.code==='DISCOVERY_RESPONSE_LIMIT')throw error;throw fault('DISCOVERY_RESPONSE','The employer feed returned invalid JSON.');}
}

export class JobDiscovery{
 constructor({store,fetcher=nativeFetcher,resolver=lookup,clock=Date.now,timeoutMs=DISCOVERY_LIMITS.timeoutMs,minIntervalMs=DISCOVERY_LIMITS.minIntervalMs,staleMs=DISCOVERY_LIMITS.staleMs}={}){Object.assign(this,{store,fetcher,resolver,clock,timeoutMs:Math.min(DISCOVERY_LIMITS.timeoutMs,Math.max(20,timeoutMs)),minIntervalMs:Math.max(1,minIntervalMs),staleMs:Math.max(1,staleMs),epoch:0,closed:false,busy:false});this.controllers=new Set();}
 assertOpen(){if(this.closed)throw fault('DISCOVERY_REVOKED','This discovery workspace is closed.');}
 invalidate(){this.epoch++;for(const controller of this.controllers)controller.abort();}
 close(){this.closed=true;this.invalidate();}
 registerSource({boardUrl,label}={}){
  this.assertOpen();const parsed=parseDiscoverySource(boardUrl),prior=this.store.get('discovery_source',parsed.id);if(!prior&&this.store.list('discovery_source').length>=DISCOVERY_LIMITS.sources)throw fault('DISCOVERY_SOURCE_LIMIT','The employer source limit has been reached.',400);
  if(label!==undefined&&(typeof label!=='string'||!text(label)||label.length>200))throw fault('DISCOVERY_SOURCE','Use an employer label of at most 200 characters.',400);
  const name=label===undefined?prior?.label||parsed.board:text(label,200);if(prior&&name===prior.label)return this.sourceStatus(prior);
  this.invalidate();return this.sourceStatus(this.store.put('discovery_source',{...prior,...parsed,label:name,revision:(prior?.revision||0)+1,status:prior?.lastObservedAt?'stale':'unknown',coverage:prior?.coverage||null,lastErrorCode:null}));
 }
 removeSource(id){this.assertOpen();if(!this.store.get('discovery_source',id))throw fault('DISCOVERY_SOURCE_MISSING','The employer source is no longer registered.',404);this.invalidate();this.store.remove('discovery_source',id);return {removed:true,id};}
 sourceStatus(source){const stale=source.lastObservedAt&&this.clock()-Date.parse(source.lastObservedAt)>this.staleMs;return {...source,status:source.status==='unavailable'?'unavailable':stale?'stale':source.status||'unknown',nextRefreshAt:this.store.get('discovery_rate',source.id)?.nextRefreshAt||null};}
 candidateStatus(row,source=this.store.get('discovery_source',row.sourceId),favorite=this.store.get('discovery_favorite',row.id)?.favorite===true,state=source?this.sourceStatus(source).status:'unknown'){const current=row.availability==='active'&&source?.lastObservedAt===row.lastSeenAt&&['ready','partial'].includes(state);return {...row,locationScope:['us','outside_us','unknown'].includes(row.locationScope)?row.locationScope:discoveryLocationScope(row.location,row.country),favorite,availability:current?'active':row.availability==='missing'&&state==='ready'?'missing':'unknown',observationStatus:state,queueEligible:current};}
 snapshot({query='',provider='',sourceId='',favoriteOnly=false,usOnly=false,locationScope='',availability='',location='',workplace='',roleType='',discipline='',sort='recent',limit=40,offset=0}={}){
  this.assertOpen();if(typeof query!=='string'||query.length>500||!['','greenhouse','lever'].includes(provider)||typeof sourceId!=='string'||sourceId.length>250||typeof favoriteOnly!=='boolean'||typeof usOnly!=='boolean'||!['','us','outside_us','unknown'].includes(locationScope)||!['','active','missing','unknown'].includes(availability))throw fault('DISCOVERY_FILTER','The discovery filters are invalid.',400);
  if([location,workplace,roleType,discipline].some(value=>typeof value!=='string'||value.length>250)||!['recent','firstSeen','title','company'].includes(sort))throw fault('DISCOVERY_FILTER','The discovery keyword filters or sorting are invalid.',400);
  if(!Number.isInteger(limit)||limit<0||limit>100||!Number.isInteger(offset)||offset<0||offset>150000)throw fault('DISCOVERY_FILTER','Use a bounded discovery page.',400);
  const sources=this.store.list('discovery_source').map(source=>this.sourceStatus(source)),sourceMap=new Map(sources.map(source=>[source.id,source])),favorites=new Set(this.store.list('discovery_favorite').filter(row=>row.favorite===true).map(row=>row.id)),stored=this.store.list('discovery_candidate');
  const includes=(value,term)=>!term||String(value||'').toLocaleLowerCase().includes(term.toLocaleLowerCase()),terms=query.toLocaleLowerCase().split(/\s+/).filter(Boolean),all=stored.map(row=>this.candidateStatus(row,sourceMap.get(row.sourceId)||null,favorites.has(row.id),sourceMap.get(row.sourceId)?.status||'unknown')),matched=all.filter(row=>(!provider||row.provider===provider)&&(!sourceId||row.sourceId===sourceId)&&(!favoriteOnly||row.favorite)&&(!availability||row.availability===availability)&&includes(row.location,location)&&includes(row.workplaceType,workplace)&&(roleType.trim().toLocaleLowerCase()==='intern'?/\bintern(?:ship)?s?\b/i.test([row.title,row.employmentType].join(' ')):includes([row.title,row.employmentType].join(' '),roleType))&&includes([row.title,row.department,row.description].join(' '),discipline)&&terms.every(term=>[row.title,row.company,row.location,row.department,row.employmentType,row.workplaceType,row.description].join(' ').toLocaleLowerCase().includes(term)));
  const geographyCounts={us:0,outside_us:0,unknown:0};for(const row of matched)geographyCounts[row.locationScope]++;
  const rows=matched.filter(row=>(!usOnly||row.locationScope==='us')&&(!locationScope||row.locationScope===locationScope)).sort((a,b)=>(sort==='title'?a.title.localeCompare(b.title):sort==='company'?a.company.localeCompare(b.company):sort==='firstSeen'?b.firstSeenAt.localeCompare(a.firstSeenAt):b.lastSeenAt.localeCompare(a.lastSeenAt))||a.id.localeCompare(b.id));
  return {sources,suggestions:DISCOVERY_SUGGESTIONS.map(row=>({...row})),limits:{...DISCOVERY_LIMITS},candidates:rows.slice(offset,offset+limit),total:rows.length,offset,limit,readOnly:true,filterSemantics:'Local keyword search across retained employer-feed candidates; descriptions are bounded previews and may be unavailable on large boards; no eligibility or degree inference.',geographyCounts,geographySemantics:'US means explicit feed country or unambiguous US location cues. ATS region is not geography. Unknown and conflicting locations remain available for review; this is not eligibility or work authorization.',counters:{stored:stored.length,favorites:favorites.size,us:all.filter(row=>row.locationScope==='us').length,outsideUs:all.filter(row=>row.locationScope==='outside_us').length,unknownLocation:all.filter(row=>row.locationScope==='unknown').length}};
 }
 setFavorite(id,favorite){this.assertOpen();if(typeof favorite!=='boolean')throw fault('DISCOVERY_FAVORITE','Favorite must be a Boolean.',400);const row=this.store.get('discovery_candidate',id);if(!row)throw fault('DISCOVERY_CANDIDATE_MISSING','This discovery candidate is unavailable.',404);this.store.put('discovery_favorite',{id,favorite});return this.candidateStatus(row);}
 candidateForQueue(id){this.assertOpen();const row=this.store.get('discovery_candidate',id);if(!row)throw fault('DISCOVERY_CANDIDATE_MISSING','This discovery candidate is unavailable.',404);if(!this.candidateStatus(row).queueEligible)throw fault('DISCOVERY_REFRESH_REQUIRED','Refresh this employer source and confirm the job is still listed before adding it to applications.');return {url:row.url,discoveryCandidateId:row.id,company:row.company,employer:row.company,title:row.title};}
 context(id){this.assertOpen();const source=this.store.get('discovery_source',id);if(!source)throw fault('DISCOVERY_SOURCE_MISSING','This employer source is no longer registered.',404);const parsed=parseDiscoverySource(source.boardUrl);if(parsed.id!==source.id||parsed.provider!==source.provider||parsed.region!==source.region||parsed.board!==source.board)throw fault('DISCOVERY_SOURCE','The stored source does not match its fixed public board.');return {source,sourceHash:hash(source),epoch:this.epoch};}
 guard(context,allowCancelled=false){this.assertOpen();if(context.cancelled&&!allowCancelled||context.epoch!==this.epoch||hash(context.source)!==context.sourceHash||hash(this.store.get('discovery_source',context.source.id))!==context.sourceHash)throw fault('DISCOVERY_REVOKED','The employer source configuration changed during refresh.');}
 async read(context,page,signal,budget,metadataOnly=false){
  this.guard(context);const url=route(context.source,page,metadataOnly),hostname=new URL(url).hostname;
  let addresses;try{addresses=await this.resolver(hostname,{all:true,verbatim:true});}catch{throw fault('DISCOVERY_DESTINATION','The public feed hostname could not be resolved safely.');}
  if(!Array.isArray(addresses)||!addresses.length||addresses.length>32||addresses.some(item=>!isIP(item.address)||privateAddress(item.address)))throw fault('DISCOVERY_DESTINATION','The official feed hostname resolved to a private or unsupported address.');
  this.guard(context);if(signal.aborted)throw fault('DISCOVERY_REVOKED','This discovery refresh was cancelled.');
  const connectionLookup=(_host,options,callback)=>{if(typeof options==='function'){callback=options;options={};}if(options?.all)callback(null,addresses);else callback(null,addresses[0].address,isIP(addresses[0].address));};
  const response=await this.fetcher(url,{method:'GET',headers:{Accept:'application/json','User-Agent':'AutomationHub-public-job-discovery/1.0'},signal,lookup:connectionLookup,redirect:'error',credentials:'omit'});this.guard(context);
  if(response.redirected||response.status>=300&&response.status<400||response.url&&response.url!==url){response.body?.destroy?.();throw fault('DISCOVERY_REDIRECT','The employer feed redirected; no redirect was followed.');}
  if(response.status!==200){response.body?.destroy?.();throw fault(response.status===429?'DISCOVERY_REMOTE_RATE_LIMIT':'DISCOVERY_UNAVAILABLE',response.status===429?'The employer feed requested a pause. Wait before refreshing again.':'The employer feed did not return its public posting list.',response.status===429?429:409);}
  const result=await boundedJSON(response,budget);this.guard(context);return result;
 }
 async refresh(id){
  if(this.busy)throw fault('DISCOVERY_BUSY','Wait for the current employer refresh.',429);const context=this.context(id),now=this.clock(),attemptedAt=new Date(now).toISOString();if(Date.parse(this.store.get('discovery_rate',id)?.nextRefreshAt||'')>now)throw fault('DISCOVERY_RATE_LIMIT','Wait before refreshing this employer source again.',429);
  this.store.put('discovery_rate',{id,nextRefreshAt:new Date(now+this.minIntervalMs).toISOString()});this.busy=true;const controller=new AbortController();this.controllers.add(controller);let timer;
  try{return await Promise.race([(async()=>{
   const rows=[],seen=new Set(),budget={bytes:0};let complete=false,pages=0,metadataOnly=false,requests=0;
   for(let page=0;page<DISCOVERY_LIMITS.pages;page++){
    let data;try{requests++;data=await this.read(context,page,controller.signal,budget);}catch(error){if(context.source.provider!=='greenhouse'||error.code!=='DISCOVERY_RESPONSE_LIMIT')throw error;this.guard(context);metadataOnly=true;requests++;data=await this.read(context,page,controller.signal,budget,true);}pages++;
    const list=context.source.provider==='greenhouse'?data?.jobs:data;
    if(!Array.isArray(list)||list.length>(context.source.provider==='greenhouse'?DISCOVERY_LIMITS.jobsPerRefresh:DISCOVERY_LIMITS.pageSize))throw fault('DISCOVERY_RESPONSE_LIMIT','The public posting list is malformed or exceeds the bounded item limit.');
    for(const item of list){const row={...candidate(context.source,item),descriptionCoverage:metadataOnly?'metadata_only':'bounded_preview'};if(seen.has(row.id))throw fault('DISCOVERY_RESPONSE','The employer feed repeated a posting identity across its snapshot.');seen.add(row.id);rows.push(row);}
    if(context.source.provider==='greenhouse'){if(data?.meta?.total!==undefined&&(!Number.isSafeInteger(data.meta.total)||data.meta.total<list.length))throw fault('DISCOVERY_RESPONSE','The employer feed returned inconsistent totals.');complete=data?.meta?.total===list.length;break;}
    if(list.length<DISCOVERY_LIMITS.pageSize){complete=true;break;}
   }
   this.guard(context);const retained=this.store.list('discovery_candidate'),previous=retained.filter(row=>row.sourceId===id);if(new Set([...previous.map(row=>row.id),...seen]).size>DISCOVERY_LIMITS.retainedPerSource||new Set([...retained.map(row=>row.id),...seen]).size>DISCOVERY_LIMITS.retainedTotal)throw fault('DISCOVERY_RETENTION_LIMIT','The retained discovery limit was reached. Existing jobs and favorites were preserved.');
   const observedAt=new Date(this.clock()).toISOString();let saved;
   this.store.transaction(()=>{
    this.guard(context);
    for(const row of rows){const prior=this.store.get('discovery_candidate',row.id);this.store.put('discovery_candidate',{...row,firstSeenAt:prior?.firstSeenAt||observedAt,lastSeenAt:observedAt,availability:'active'});}
    if(complete)for(const prior of previous)if(!seen.has(prior.id))this.store.put('discovery_candidate',{...prior,availability:'missing',lastAbsentAt:observedAt});
    saved=this.store.put('discovery_source',{...context.source,status:complete?'ready':'partial',coverage:complete?'complete':'partial',lastAttemptAt:attemptedAt,lastObservedAt:observedAt,lastErrorCode:null,jobCount:rows.length,pagesRead:pages,requestsRead:requests,descriptionCoverage:metadataOnly?'metadata_only':'bounded_preview',warningCode:metadataOnly?'DISCOVERY_DESCRIPTION_LIMIT':null});
   });return this.sourceStatus(saved);
  })(),new Promise((_,reject)=>{timer=setTimeout(()=>{context.cancelled=true;controller.abort();reject(fault('DISCOVERY_TIMEOUT','The bounded employer refresh timed out. Earlier listings were retained.'));},this.timeoutMs);})]);
  }catch(error){try{this.guard(context,error.code==='DISCOVERY_TIMEOUT');this.store.put('discovery_source',{...context.source,status:'unavailable',lastAttemptAt:attemptedAt,lastErrorCode:error.code?.startsWith('DISCOVERY_')?error.code:'DISCOVERY_UNAVAILABLE'});}catch{}if(error.code?.startsWith('DISCOVERY_'))throw error;throw fault('DISCOVERY_UNAVAILABLE','The employer refresh failed. Earlier listings and favorites were retained.');}
  finally{clearTimeout(timer);context.cancelled=true;controller.abort();this.controllers.delete(controller);this.busy=false;}
 }
}
