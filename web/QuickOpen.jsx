import React,{useEffect,useLayoutEffect,useId,useMemo,useRef,useState} from 'react';

const normalized=value=>String(value||'').normalize('NFKD').replace(/\p{M}/gu,'').toLowerCase();

// Navigation only. All external effects stay in their existing reviewed flows.
export default function QuickOpen({open,onClose,data,ready,onNavigate,onJob,onDecision,Icon}){
 const dialog=useRef(null),input=useRef(null),returnTarget=useRef(null),navigated=useRef(false),prefix=useId();
 const [query,setQuery]=useState(''),[active,setActive]=useState(0);
 const commands=useMemo(()=>[
  {id:'home',title:'Home',detail:'Your workflows and next action',kind:'Page',icon:'home',go:()=>onNavigate('home')},
  {id:'discover',title:'Browse US internships',detail:'Read public employer boards',kind:'Page',icon:'search',go:()=>onNavigate('discover')},
  {id:'applications',title:'Application queue',detail:'Selected roles, documents and progress',kind:'Page',icon:'briefcase',go:()=>onNavigate('applications')},
  {id:'resumes',title:'Résumé library',detail:'Originals and prepared versions',kind:'Page',icon:'file',go:()=>onNavigate('resumes')},
  {id:'needs',title:'Needs You',detail:'Saved questions and reviews',kind:'Page',icon:'inbox',go:()=>onNavigate('needs')},
  {id:'outcomes',title:'Outcomes',detail:'Receipts and employer responses',kind:'Page',icon:'check',go:()=>onNavigate('outcomes')},
  {id:'settings',title:'Campaign settings',detail:'Candidate details, rules and recovery',kind:'Page',icon:'settings',go:()=>onNavigate('settings')},
  ...(data.jobs||[]).map(job=>({id:`job-${job.id}`,title:job.title||'Posting awaiting verification',detail:[job.employer,String(job.state||'').replaceAll('_',' ')].filter(Boolean).join(' / '),kind:'Application',icon:'briefcase',go:()=>onJob(job)})),
  ...(data.decisions||[]).filter(item=>['open','pending','needs_you'].includes(item.state||item.status||'open')).map(item=>({id:`decision-${item.id}`,title:item.title||item.question||'Saved question',detail:(data.jobs||[]).find(job=>job.id===(item.jobId||item.applicationId))?.employer||'Needs You',kind:'Question',icon:'inbox',go:()=>onDecision(item.id)}))
 ],[data,onNavigate,onJob,onDecision]);
 const matching=useMemo(()=>{const words=normalized(query).trim().split(/\s+/).filter(Boolean);return commands.filter(item=>words.every(word=>normalized(`${item.title} ${item.detail} ${item.kind}`).includes(word)));},[commands,query]);
 const results=matching.slice(0,30);
 useEffect(()=>{if(open)document.getElementById(`${prefix}-${active}`)?.scrollIntoView({block:'nearest'});},[open,active,prefix]);
 useEffect(()=>{setActive(0);},[query]);
 useLayoutEffect(()=>{
  if(!open)return;
  const element=dialog.current;navigated.current=false;returnTarget.current=document.activeElement;setQuery('');setActive(0);element.showModal();input.current?.focus();
  return()=>{if(element.open)element.close();if(!navigated.current&&returnTarget.current?.isConnected)returnTarget.current.focus({preventScroll:true});};
 },[open]);
 useEffect(()=>{if(open&&!ready)onClose();},[open,ready,onClose]);
 if(!open)return null;
 const choose=item=>{if(!ready||!item)return;navigated.current=true;dialog.current?.close();onClose();item.go();};
 const dismissWithEscape=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}};
 return <dialog ref={dialog} className="quick-open" aria-label="Find in your workspace" onKeyDownCapture={dismissWithEscape} onCancel={event=>{event.preventDefault();onClose();}} onClick={event=>{if(event.target===dialog.current)onClose();}}>
  <div className="quick-open-search"><Icon name="search" size={21}/><input ref={input} type="search" role="combobox" aria-label="Find a page, application or question" aria-controls={`${prefix}-results`} aria-expanded="true" aria-autocomplete="list" aria-activedescendant={results.length?`${prefix}-${Math.min(active,results.length-1)}`:undefined} placeholder="Find a page, application or question" value={query} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();setActive(value=>(value+(event.key==='ArrowDown'?1:-1)+results.length)%Math.max(1,results.length));}else if(event.key==='Enter'){event.preventDefault();choose(results[Math.min(active,results.length-1)]);}}}/><button className="icon-button" aria-label="Close workspace search" onClick={onClose}><Icon name="close"/></button></div>
  <div className="quick-open-results" role="listbox" id={`${prefix}-results`} aria-label="Workspace results">{results.map((item,index)=><button type="button" tabIndex={-1} role="option" aria-selected={index===active} id={`${prefix}-${index}`} key={item.id} onMouseMove={()=>setActive(index)} onClick={()=>choose(item)}><Icon name={item.icon}/><span><strong>{item.title}</strong><small>{item.detail}</small></span><span className="quick-open-kind">{item.kind}</span></button>)}</div>
  <div className="quick-open-footer" role="status">{matching.length===0?'No matches in this workspace':matching.length>30?`Showing 30 of ${matching.length} matches. Keep typing to narrow them down.`:`${matching.length} ${matching.length===1?'destination':'destinations'}`}<span>↑ ↓ to move <kbd>Return</kbd> to open</span></div>
 </dialog>;
}
