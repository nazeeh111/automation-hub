// A view is browsing intent only. Results and authority always come from a fresh query.
export const DISCOVERY_PAGE_SIZE=40;
const defaults=Object.freeze({query:'',scope:'us',company:'',location:'',field:'',style:'',sort:'firstSeen',includeUnavailable:true,filtersOpen:false,sourcesOpen:false,selectedId:null,offset:0});
const filterFields=new Set(['query','scope','company','location','field','style','sort','includeUnavailable']);
export function normalizeDiscoveryView(value){
 const input=value&&typeof value==='object'&&!Array.isArray(value)?value:{},view={...defaults};
 for(const field of ['query','company','location','field','style'])if(typeof input[field]==='string')view[field]=input[field];
 if(['us','all','saved','review'].includes(input.scope))view.scope=input.scope;
 if(['firstSeen','recent','company'].includes(input.sort))view.sort=input.sort;
 for(const field of ['includeUnavailable','filtersOpen','sourcesOpen'])if(typeof input[field]==='boolean')view[field]=input[field];
 if(typeof input.selectedId==='string'&&input.selectedId.length>0&&input.selectedId.length<=350)view.selectedId=input.selectedId;
 if(Number.isInteger(input.offset)&&input.offset>=0&&input.offset<=150000)view.offset=Math.floor(input.offset/DISCOVERY_PAGE_SIZE)*DISCOVERY_PAGE_SIZE;
 return view;
}
export function updateDiscoveryView(view,field,value){
 if(!Object.hasOwn(defaults,field))return view;
 const next=normalizeDiscoveryView({...view,[field]:typeof value==='function'?value(view[field]):value});
 if(filterFields.has(field)&&next[field]!==view[field]){next.offset=0;next.selectedId=null;}
 return Object.keys(defaults).every(key=>next[key]===view[key])?view:next;
}
export function clampDiscoveryOffset(offset,total){
 if(!Number.isInteger(total)||total<0)throw new Error('The source results could not be verified. Try again.');
 return total===0?0:Math.min(offset,Math.floor((total-1)/DISCOVERY_PAGE_SIZE)*DISCOVERY_PAGE_SIZE);
}
