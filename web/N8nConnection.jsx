import React, {useEffect,useState} from 'react';
import './n8n.css';

const readable=value=>String(value||'unknown').replaceAll('_',' ').replace(/^./,character=>character.toUpperCase());
const date=value=>value?new Date(value).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'Not observed';

export function observedWorkflow(automation,connection) {
  const current=connection?.observations?.find(item=>item.automationId===automation.id);
  return current?{...automation,observationStatus:current.status,observation:current.observation,lastObservedAt:current.observedAt,lastObservationAttemptAt:current.lastAttemptAt,lastObservationErrorCode:current.lastErrorCode,nextRefreshAt:current.nextRefreshAt}:automation;
}
export function workflowStatus(automation,connection) {
  if(connection?.configured&&connection.locked)return {tone:'limited',text:'Vault locked'};
  const status=automation.observationStatus||'unverified';
  if(status==='unavailable')return {tone:'limited',text:'Status unavailable'};
  if(status==='stale')return {tone:'limited',text:'Stale observation'};
  if(status!=='observed'||!automation.observation?.workflow)return {tone:'neutral',text:'Not observed'};
  const workflow=automation.observation.workflow;
  return workflow.isArchived===true?{tone:'neutral',text:'Archived in n8n'}:workflow.active===true?{tone:'ready',text:'Active in n8n'}:workflow.active===false?{tone:'neutral',text:'Inactive in n8n'}:{tone:'limited',text:'Activation unknown'};
}

export function WorkflowObservation({automation:a}) {
  if(!a.observation&&!a.lastObservationAttemptAt)return null;
  const observation=a.observation,workflow=observation?.workflow;
  const knownState=workflow?.isArchived===true?'archived':workflow?.active===true?'active':workflow?.active===false?'inactive':'unknown';
  return <details className="n8n-history"><summary>View observed status and history</summary>
    {a.lastObservationErrorCode&&<p className="n8n-read-error" role="status">The last status read failed: {readable(a.lastObservationErrorCode)}. {observation?'The previous observation is retained below; current state is unknown.':'No workflow state has been verified.'}</p>}
    <dl className="n8n-observation-facts"><div><dt>Last successful read</dt><dd>{date(a.lastObservedAt)}</dd></div>{a.lastObservationAttemptAt&&<div><dt>Last read attempt</dt><dd>{date(a.lastObservationAttemptAt)}</dd></div>}{workflow&&<div><dt>State at last successful read</dt><dd>{readable(knownState)} / {workflow.name}</dd></div>}</dl>
    {observation&&<section className="n8n-executions" aria-label="Recent visible n8n execution history"><h3>Recent visible execution history</h3><p>Metadata only. This bounded history does not establish whether a workflow is currently running.</p>{observation.executions?.length?<ol>{observation.executions.map(execution=><li key={execution.id}><div><strong>{readable(execution.status)}</strong><span>Execution {execution.id}</span></div><dl><div><dt>Started</dt><dd>{date(execution.startedAt)}</dd></div>{execution.stoppedAt&&<div><dt>Stopped</dt><dd>{date(execution.stoppedAt)}</dd></div>}{execution.waitTill&&<div><dt>Waiting until</dt><dd>{date(execution.waitTill)}</dd></div>}</dl></li>)}</ol>:<p className="n8n-empty-history">No executions were returned in this bounded history view.</p>}{observation.historyHasMore&&<p>More execution history is available in n8n.</p>}</section>}
  </details>;
}

export default function N8nConnection({connection={},vault={},perform,busy,onVault}) {
  const [baseUrl,setBaseUrl]=useState(connection.baseUrl||''),[apiKey,setApiKey]=useState(''),[confirmed,setConfirmed]=useState(false),[allowLocal,setAllowLocal]=useState(false);
  const saving=busy==='configureN8nObserver',unlocked=Boolean(vault.configured&&vault.unlocked);
  useEffect(()=>{if(connection.baseUrl)setBaseUrl(connection.baseUrl);},[connection.baseUrl]);
  useEffect(()=>{if(!unlocked){setApiKey('');setConfirmed(false);}},[unlocked]);
  const save=async event=>{event.preventDefault();const key=apiKey;setApiKey('');setConfirmed(false);await perform('configureN8nObserver',{baseUrl,apiKey:key,confirmed,allowLocal},'Read-only n8n connection saved. Refresh a linked workflow to verify its status.');};
  return <section className="n8n-connection" aria-labelledby="n8n-connection-title"><div className="n8n-connection-heading"><div><span className="section-kicker">Optional connection</span><h2 id="n8n-connection-title">n8n status</h2><p>Keep your existing workflows in n8n. This connection reads selected workflow status and recent execution metadata.</p></div><span className={`badge badge-${connection.state==='ready'?'ready':'neutral'}`}><span/>{connection.configured?readable(connection.state):'Not connected'}</span></div>
    {connection.configured&&<p className="n8n-connection-state">{connection.baseUrl}<br/>{connection.detail||'Refresh a selected workflow to check its current status.'}</p>}
    <details className="n8n-setup"><summary>{connection.configured?'Connection settings':'Connect read-only n8n status'}</summary><p>Use an API key from your own n8n instance with workflow:read and execution:list access. The key is stored in the shared encrypted app vault. Saving it does not verify access.</p>
      {!unlocked&&<div className="n8n-vault-gate"><p>{vault.configured?'Unlock the private app vault before entering an n8n key.':'Set up the private app vault before entering an n8n key.'}</p><button className="button secondary" type="button" onClick={onVault}>Open vault settings</button></div>}
      <form onSubmit={save} autoComplete="off"><label className="field"><span>n8n instance URL</span><input type="url" required aria-label="n8n instance URL" placeholder="https://your-n8n.example" value={baseUrl} disabled={saving} onChange={event=>{setBaseUrl(event.target.value);setConfirmed(false);setAllowLocal(false);}}/><small>Use the instance address, without a workflow page or API route.</small></label><label className="field"><span>n8n API key</span><input type="password" required aria-label="n8n API key" autoComplete="off" value={apiKey} disabled={!unlocked||saving} onChange={event=>{setApiKey(event.target.value);setConfirmed(false);}}/></label>
        <label className="check-field"><input type="checkbox" aria-label="Allow read-only access to my selected n8n workflows" checked={confirmed} disabled={!unlocked||saving} onChange={event=>setConfirmed(event.target.checked)}/><span>Allow read-only access to my selected n8n workflows<small>Workflow status and execution metadata only. Execution and schedules remain owned by n8n.</small></span></label><label className="check-field"><input type="checkbox" aria-label="Allow HTTP access to my local n8n instance" checked={allowLocal} disabled={saving} onChange={event=>{setAllowLocal(event.target.checked);setConfirmed(false);}}/><span>Allow HTTP access to my local n8n instance<small>Optional. Only localhost or 127.0.0.1 is supported for this local connection.</small></span></label><button className="button secondary" type="submit" disabled={!unlocked||!confirmed||!apiKey||!baseUrl.trim()||saving}>{saving?'Saving…':'Save read-only connection'}</button>
      </form>
    </details>
    <p className="n8n-optional-note">Optional for the shared hub. Internship applications work independently of this connection.</p>
  </section>;
}
