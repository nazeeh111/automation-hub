import React,{useEffect,useRef,useState} from 'react';
import './worker-status.css';

const when=value=>value?new Date(value).toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not observed';
export default function WorkerStatus({queryStatus,workspaceReady,campaign,onWorkspace}){
 const [view,setView]=useState({value:null,loading:false,error:''}),scope=useRef(0),pending=useRef(false),query=useRef(queryStatus);query.current=queryStatus;
 const read=async()=>{
  if(!workspaceReady||pending.current)return;const owner=scope.current;pending.current=true;setView(previous=>({...previous,loading:true,error:''}));
  try{const value=await query.current();if(scope.current!==owner)return;if(!value?.engine||typeof value.engine.busy!=='boolean'||!value.observedAt)throw new Error('The worker status could not be verified.');setView({value,loading:false,error:''});}
  catch(error){if(scope.current===owner)setView(previous=>({...previous,loading:false,error:error.message||'The worker status could not be read.'}));}
  finally{if(scope.current===owner)pending.current=false;}
 };
 useEffect(()=>{scope.current++;pending.current=false;setView({value:null,loading:false,error:''});if(workspaceReady)read();return()=>{scope.current++;pending.current=false;};},[workspaceReady]);
 const engine=view.value?.engine;
 const state=!workspaceReady?'Reconnect to check':view.error?'Status read failed':!engine?'Not checked':engine.stopped?'Worker stopped':engine.stopping?'Worker stopping':engine.busy?(engine.activePhase==='apply'?'Applying to a selected role':engine.activePhase==='prepare'?'Preparing an application':'Work in progress'):!engine.scheduled?'Automatic checks stopped':'Waiting for work';
 const authority=campaign.status==='paused'?'Campaign paused':campaign.enabled?'Campaign enabled':'Campaign off';
 return <section className="worker-status" aria-label="Local worker status">
  <header><div><h2>Local worker</h2><p>Check the app worker without starting or resuming applications.</p></div><button className="button secondary" disabled={!workspaceReady||view.loading} onClick={read}>{view.loading?'Checking worker…':'Refresh worker status'}</button></header>
  <div className="worker-status-line"><strong>{state}</strong><span>{authority}</span>{view.value&&<small>Read <time dateTime={view.value.observedAt}>{when(view.value.observedAt)}</time></small>}</div>
  {view.error&&<p className="worker-read-error" role="alert">{view.error}{view.value?' The previous read is retained below.':''}</p>}
  {engine?.lastErrorCode&&<p className="worker-loop-error">A worker check failed at {when(engine.lastErrorAt)}. {engine.lastTickCompletedAt&&Date.parse(engine.lastTickCompletedAt)>Date.parse(engine.lastErrorAt)?'A later worker check completed. The earlier failure remains recorded.':'Review the saved queue before deciding how to recover.'} This is separate from individual application outcomes.</p>}
  {engine&&<details><summary>Worker check details</summary><dl><div><dt>Last check started</dt><dd>{when(engine.lastTickStartedAt)}</dd></div><div><dt>Last check completed</dt><dd>{when(engine.lastTickCompletedAt)}</dd></div>{engine.activeStartedAt&&<div><dt>Current work started</dt><dd>{when(engine.activeStartedAt)}</dd></div>}<div><dt>Worker started</dt><dd>{when(engine.startedAt)}</dd></div></dl><p>A completed worker check can mean waiting or checking the queue. Employer receipts establish application success. Status is from this read; refresh to check again.</p></details>}
  <button className="worker-queue-link" onClick={onWorkspace} disabled={!workspaceReady}>Open application queue <span aria-hidden="true">→</span></button>
 </section>;
}
