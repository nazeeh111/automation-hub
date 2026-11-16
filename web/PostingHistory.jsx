import React, {useEffect, useRef, useState} from 'react';

const time = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : 'Not recorded';
const label = value => String(value || '').replace(/([a-z])([A-Z])/g,'$1 $2').replaceAll('_',' ').replace(/^./, letter => letter.toUpperCase());
const sourceLink = value => {try {const url = new URL(value);return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;} catch {return null;}};
export function changedTextExcerpt(before = '', after = '') {
  if (typeof before !== 'string' || typeof after !== 'string' || before === after) return null;
  let start = 0, left = before.length, right = after.length;
  while (start < left && start < right && before[start] === after[start]) start++;
  while (left > start && right > start && before[left - 1] === after[right - 1]) {left--;right--;}
  const from = Math.max(0, start - 120);
  const excerpt = (value, end) => {const through = Math.min(value.length, end + 120),to = Math.min(through,from + 4000);return {text:value.slice(from,to),prefix:value.slice(from,start),changed:value.slice(start,Math.min(end,to)),suffix:value.slice(Math.min(end,to),to),truncated:from > 0 || through < value.length || through - from > 4000};};
  return {before:excerpt(before,left),after:excerpt(after,right)};
}

function Observation({title, observation, Icon}) {
  if (!observation) return <section className="posting-observation"><h5>{title}</h5><p>No matching retained observation is available</p></section>;
  const posting = observation.posting || {}, url = sourceLink(posting.sourceUrl || posting.url);
  return <section className="posting-observation"><h5>{title}</h5><strong>{posting.title || 'Title not supplied'}</strong><span>{posting.employer || 'Employer not supplied'}</span><time>Observed {time(observation.observedAt || observation.recordedAt)}</time>{posting.deadlineLabel || posting.deadline ? <p>Deadline {posting.deadlineLabel || time(posting.deadline)}{posting.deadlineUncertain ? ' / date needs review' : ''}</p> : <p>No deadline supplied</p>}<details><summary>Read retained source text</summary><pre>{posting.text || 'This observation did not retain posting text'}</pre></details><details><summary>Source identity</summary><dl><div><dt>Adapter source hash</dt><dd>{observation.sourceHash || 'Unavailable'}</dd></div><div><dt>Retained content hash</dt><dd>{observation.contentHash || 'Unavailable'}</dd></div></dl><p>The adapter hash can include normalized text and form metadata. It is separate from the retained content hash.</p>{url && <a href={url} target="_blank" rel="noreferrer">Open source posting<Icon name="external" size={14}/></a>}</details></section>;
}

export default function PostingHistory({job, pkg, queryPostings, workspaceReady, onPrepare, onContextChanged, busy, Icon}) {
  const [loaded, setLoaded] = useState(null), [loading,setLoading] = useState(true), [error,setError] = useState(''), [refresh,setRefresh] = useState(0);
  const sequence = useRef(0), identity = useRef('');
  const key = JSON.stringify([job.id,job.identity||job.id,job.postingObservationId||null,job.latestPostingObservationId||null,pkg?.id||null,pkg?.postingBinding||null,workspaceReady]);
  if (identity.current !== key) {identity.current = key;sequence.current++;}
  const value = loaded?.key === key ? loaded.value : null;
  useEffect(() => {
    const request = ++sequence.current;let active = true;
    setLoading(true);setError('');
    if (!workspaceReady) return () => {active = false;sequence.current++;};
    Promise.resolve().then(() => queryPostings({jobId:job.id,limit:2})).then(result => {
      if (!active || request !== sequence.current) return;
      const observations = [...(Array.isArray(result?.observations) ? result.observations : []), result?.currentObservation, result?.latestObservation, result?.packageObservation].filter(Boolean);
      if (!Array.isArray(result?.observations) || observations.some(item => item.jobId !== job.id || item.jobIdentity !== (job.identity || job.id))) throw new Error('The retained posting sources could not be verified. Refresh them and try again.');
      if ((result.currentObservationId || null) !== (job.postingObservationId || null) || (result.latestObservationId || null) !== (job.latestPostingObservationId || job.postingObservationId || null) || (result.packageObservationId || null) !== (pkg?.postingBinding?.observationId || null)) {
        const problem = new Error('The application source context changed. Refresh the workspace to inspect the current version.');problem.code = 'POSTING_CONTEXT_CHANGED';throw problem;
      }
      setLoaded({key,value:result});setLoading(false);
    }).catch(problem => {if (active && request === sequence.current) {setError(problem.message || 'Retained sources could not be loaded');setLoading(false);if(problem.code==='POSTING_CONTEXT_CHANGED')Promise.resolve(onContextChanged?.()).catch(()=>{});}});
    return () => {active = false;sequence.current++;};
  }, [key, queryPostings, refresh]);
  const baseline = value?.packageObservation || value?.currentObservation;
  const latest = value?.latestObservation;
  const changed = Boolean(baseline && latest && baseline.id !== latest.id);
  const excerpt = changed ? changedTextExcerpt(baseline.posting?.text,latest.posting?.text) : null;
  return <section className="posting-history" aria-label="Retained posting versions" aria-busy={loading}><div className="posting-history-heading"><div><h4>Retained posting sources</h4><p>Inspect what preparation used and what the employer last returned.</p></div><button type="button" disabled={loading || !workspaceReady} onClick={() => setRefresh(number => number + 1)}><Icon name="refresh" size={16}/>Refresh retained sources</button></div>{error && <p className="posting-history-error" role="alert">{error}{value ? ' Previously loaded sources remain below.' : ''}</p>}{loading && <p role="status">Reading retained sources…</p>}{!loading && !error && !latest && <p>No source observation has been retained yet. Preparation will read the actual posting.</p>}{value && <>{changed && <div className="posting-change-notice"><strong>The employer posting changed</strong><p>The retained document does not establish readiness for this newer source. Prepare it again and review the resulting version before it can continue.</p>{value.comparison?.changedFields?.length > 0 && <p>Changed fields: {value.comparison.changedFields.map(label).join(', ')}</p>}{onPrepare && <button type="button" disabled={Boolean(busy) || !workspaceReady} onClick={onPrepare}>Prepare updated posting</button>}</div>}{!pkg?.postingBinding && pkg && <p className="posting-legacy-note">This older package has no retained posting binding. Keep it for reference and prepare a current version before approval.</p>}{latest && <div className={`posting-observation-pair ${changed ? 'has-change' : ''}`}>{changed ? <><Observation title={value.packageObservation ? 'Source used for this document' : 'Previously adopted source'} observation={baseline} Icon={Icon}/><Observation title="Latest observed source" observation={latest} Icon={Icon}/></> : <Observation title="Latest observed source" observation={latest} Icon={Icon}/>}</div>}{excerpt && <details className="posting-text-change"><summary>Compare changed text</summary><p>Changed range with nearby context. Separate changes can share this range; open the retained sources for their complete retained text.</p><div><section><h5>Before</h5><pre>{excerpt.before.prefix}<del>{excerpt.before.changed}</del>{excerpt.before.suffix}{!excerpt.before.text && '(No text in this range)'}</pre></section><section><h5>After</h5><pre>{excerpt.after.prefix}<ins>{excerpt.after.changed}</ins>{excerpt.after.suffix}{!excerpt.after.text && '(No text in this range)'}</pre></section></div>{(excerpt.before.truncated || excerpt.after.truncated) && <p>This is a bounded excerpt, not the complete source.</p>}</details>}{changed && !excerpt && <p>Retained text is unchanged. The adapter reported a different source identity or metadata; compare the source details before preparing again.</p>}<p className="posting-retention-note">Refreshing this panel reads local retained evidence. It does not contact the employer or enable a campaign.</p></>}</section>;
}
