import React,{useEffect,useRef,useState} from 'react';
import './job-activity.css';

const title=value=>String(value||'Recorded event').replaceAll('_',' ').replace(/^./,letter=>letter.toUpperCase());
const time=value=>Number.isFinite(Date.parse(value))?new Date(value).toLocaleString():null;
const blank=epoch=>({epoch,events:[],status:'idle',hasMore:false,nextCursor:null,error:'',retryEarlier:false});

// Each page belongs to one current application and workspace admission. This
// component never falls back to the dashboard's bounded recent-event summary.
export default function JobActivity({job,queryEvents,workspaceReady,Icon}){
 const jobId=job?.id||'',scope=useRef({jobId,ready:workspaceReady,epoch:0}),pending=useRef(null),sequence=useRef(0),mounted=useRef(false),query=useRef(queryEvents),range=useRef(null),focusRange=useRef(false);
 const [view,setView]=useState(()=>blank(0));query.current=queryEvents;
 if(scope.current.jobId!==jobId||scope.current.ready!==workspaceReady){scope.current={jobId,ready:workspaceReady,epoch:scope.current.epoch+1};pending.current=null;focusRange.current=false;}
 const current=view.epoch===scope.current.epoch?view:blank(scope.current.epoch),latest=useRef(current);latest.current=current;

 const load=async earlier=>{
  const owner={...scope.current},base=latest.current;
  if(!mounted.current||!owner.ready||!owner.jobId||pending.current!==null||(earlier&&(!base.hasMore||!base.nextCursor)))return;
  const request=++sequence.current,before=earlier?base.nextCursor:undefined;pending.current=request;
  const owns=()=>mounted.current&&scope.current.epoch===owner.epoch&&scope.current.jobId===owner.jobId&&scope.current.ready&&pending.current===request;
  setView({...base,epoch:owner.epoch,status:earlier?'earlier':'loading',error:'',retryEarlier:earlier});
  try{
   if(typeof query.current!=='function')throw new Error('Application history is not connected. Reconnect the workspace and try again.');
   const result=await query.current({jobId:owner.jobId,limit:30,...(before?{before}:{})});
   if(!owns())return;
   if(!result||!Array.isArray(result.events)||typeof result.hasMore!=='boolean'||result.events.some(event=>!event||typeof event.id!=='string')||(result.hasMore&&(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor===before)))throw new Error('The saved history page could not be verified. Try again.');
   const seen=new Set(),events=[...(earlier?base.events:[]),...result.events].filter(event=>{if(seen.has(event.id))return false;seen.add(event.id);return true;});
   focusRange.current=earlier&&!result.hasMore;
   setView({epoch:owner.epoch,events,status:'ready',hasMore:result.hasMore,nextCursor:result.hasMore?result.nextCursor:null,error:'',retryEarlier:false});
  }catch(error){if(owns())setView({...base,epoch:owner.epoch,status:'error',error:error?.message||'The saved application history could not be loaded. Try again.',retryEarlier:earlier});}
  finally{if(owns())pending.current=null;}
 };

 useEffect(()=>{
  mounted.current=true;setView(blank(scope.current.epoch));latest.current=blank(scope.current.epoch);
  if(workspaceReady&&jobId)load(false);
  return()=>{mounted.current=false;scope.current.epoch++;pending.current=null;focusRange.current=false;};
 },[jobId,workspaceReady]);
 useEffect(()=>{if(current.status==='ready'&&focusRange.current){focusRange.current=false;range.current?.focus({preventScroll:true});}},[current.status,current.events.length]);

 const loading=current.status==='loading'||current.status==='idle',earlier=current.status==='earlier';
 return <section className="job-activity" aria-label="Application execution history" aria-busy={workspaceReady&&(loading||earlier)}>
  <header className="job-activity-heading"><div><h4>Execution history</h4><p>Saved events for this application, newest first</p></div>{workspaceReady&&current.events.length>0&&<button type="button" className="job-activity-refresh" aria-label="Refresh application history" aria-disabled={loading||earlier} onClick={()=>load(false)}>{Icon&&<Icon name="refresh" size={16}/>}Refresh</button>}</header>
  {!workspaceReady?<p className="job-activity-status" role="status">Reconnect the workspace to load this application’s saved history</p>:<>
   {loading&&<p className="job-activity-status" role="status">Loading saved application history…</p>}
   {current.events.length>0&&<ol className="job-activity-list" aria-label="Saved execution events">{current.events.map(event=>{const recordedAt=event.at||event.createdAt,stamp=time(recordedAt),detail=event.payload?.message||event.payload?.detail||event.detail;return <li key={event.id} data-event-id={event.id}><span className="job-activity-point" aria-hidden="true"/><div><strong>{event.message||title(event.type)}</strong>{typeof detail==='string'&&detail&&<p>{detail}</p>}{stamp?<time dateTime={recordedAt}>{stamp}</time>:<span className="job-activity-time">Time not recorded</span>}</div></li>;})}</ol>}
   {current.status==='ready'&&!current.events.length&&<p className="job-activity-status">No execution history yet</p>}
   {current.error&&<div className="job-activity-error" role="alert"><div><strong>{current.retryEarlier?'Earlier events could not be loaded':'Execution history could not be loaded'}</strong><p>{current.error}</p>{current.events.length>0&&<p>Your loaded history has been kept</p>}</div><button type="button" className="button secondary" onClick={()=>load(current.retryEarlier)}>{Icon&&<Icon name="refresh" size={16}/>}Try again</button></div>}
   {current.events.length>0&&<footer className="job-activity-footer"><p role="status" tabIndex={-1} ref={range}>{current.events.length} saved {current.events.length===1?'event':'events'} shown{current.status==='ready'&&!current.hasMore?' · Beginning of saved history':''}</p>{current.hasMore&&!current.error&&<button type="button" className="button secondary" aria-disabled={earlier} onClick={()=>load(true)}>{earlier?'Loading earlier events…':'Load earlier events'}</button>}</footer>}
  </>}
 </section>;
}
