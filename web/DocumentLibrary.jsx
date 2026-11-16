import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import PdfPreview from './PdfPreview.jsx';
import { packagePostingCurrent } from './application-view.mjs';
import './document-library.css';

const documentName = document => document.name || document.filename || 'Untitled resume';
const fileUrl = (id, query = '') => `/api/files/${encodeURIComponent(id)}${query}`;
const dateLabel = value => {
  const date = new Date(value);
  return value && Number.isFinite(date.getTime())
    ? date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
    : 'Date not recorded';
};
const previewHold = document => ({
  needs_resource_review: 'Document resources need review',
  needs_review: 'Source and preview need review',
  needs_renderer: 'Preview needs a renderer',
}[document?.renderStatus] || 'Preview is not available');

function currentPacket(pkg, job, profileRevision) {
  return Boolean(job && pkg.verified === true && pkg.jobId === job.id &&
    job.packageId === pkg.id && typeof pkg.profileRevision === 'string' &&
    pkg.profileRevision.length > 0 && pkg.profileRevision === profileRevision &&
    packagePostingCurrent(job, pkg));
}

export default function DocumentLibrary({
  data, demo, onImport, onJob, onApprove, canApprove, busy, Icon, Button, Badge,
}) {
  const resumes = data.resumes || [];
  const packages = data.packages || [];
  const jobs = data.jobs || [];
  const finished = resumes.filter(document => !document.mega);
  const evidence = resumes.filter(document => document.mega);
  const headingId = useId();
  const [selection, setSelection] = useState(null);
  const [chooserOpen, setChooserOpen] = useState(() => !window.matchMedia('(max-width:760px)').matches);
  const chooser=useRef(null), previewHeading=useRef(null), focusIntent=useRef(null);
  useEffect(()=>{const media=window.matchMedia('(max-width:760px)');const update=()=>{const moveFocus=media.matches&&chooser.current?.contains(document.activeElement);setChooserOpen(!media.matches);if(moveFocus)requestAnimationFrame(()=>chooser.current?.querySelector('summary')?.focus());};media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);

  // Retain intent, never a document object from an earlier workspace response.
  // The owning App keys this component by workspace.
  const selectedSource = selection?.kind === 'source'
    ? resumes.find(document => document.id === selection.id) : null;
  const selectedPackage = selection?.kind === 'package'
    ? packages.find(pkg => pkg.id === selection.id) : null;
  const fallback = finished[0] || evidence[0];
  const source = selectedPackage
    ? resumes.find(document => document.id === selectedPackage.resumeId)
    : selectedSource || fallback;
  const packet = selectedPackage || (!source && !selection ? packages[0] : null);
  const activeSource = packet
    ? resumes.find(document => document.id === packet.resumeId) : source;
  const selected = packet || activeSource;
  const owningJob = packet ? jobs.find(job => job.id === packet.jobId) : null;
  const packetCurrent = packet && currentPacket(packet, owningJob, data.profile?.updatedAt);
  const previewReady = packet ? packet.verified === true : activeSource?.renderStatus === 'ready';
  const approving = busy === 'reviewPackage';
  const approvalAllowed = pkg => typeof canApprove === 'function' && canApprove(pkg) === true;
  const activeKey = packet ? `package:${packet.id}` : activeSource ? `source:${activeSource.id}` : '';
  const selectDocument=choice=>{focusIntent.current=`${choice.kind}:${choice.id}`;setSelection(choice);if(window.matchMedia('(max-width:760px)').matches)setChooserOpen(false);};
  useLayoutEffect(()=>{const intent=focusIntent.current;if(!intent)return;focusIntent.current=null;if(intent!==activeKey)return;previewHeading.current?.focus({preventScroll:true});previewHeading.current?.scrollIntoView({block:'start',behavior:'instant'});},[selection,activeKey]);

  function renderSourceGroup({ title, description, documents }) {
    if (!documents.length) return null;
    return <section className="document-source-group">
      <header><h3>{title}</h3><span>{documents.length}</span></header>
      <p>{description}</p>
      <div className="document-source-list">
        {documents.map(document => {
          const ready = document.renderStatus === 'ready';
          const active = activeKey === `source:${document.id}`;
          return <article className={`resume-card document-source-row${active ? ' is-selected' : ''}`} key={document.id}>
            <button className="document-select" type="button" aria-pressed={active}
              onClick={() => selectDocument({ kind: 'source', id: document.id })}>
              <Icon name="file" size={20}/>
              <span><strong>{documentName(document)}</strong><small>
                {document.format || ({'application/pdf':'PDF','text/markdown':'Markdown','text/plain':'Text','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'DOCX'}[document.mime]) || 'Preserved source'}
                {document.pages ? ` / ${document.pages} page${document.pages === 1 ? '' : 's'}` : ''}
              </small></span>
              <Icon name="chevron" size={16}/>
            </button>
            <div className="document-source-status"><Badge value={ready ? 'neutral' : 'limited'}>
              {ready ? 'Preview ready' : previewHold(document)}
            </Badge><time>{dateLabel(document.createdAt)}</time></div>
            <div className="resume-actions">
              {ready && <a className="document-text-link" target="_blank" rel="noreferrer" href={fileUrl(document.id)}>Preview document<Icon name="external" size={14}/></a>}
              <a className="document-text-link" href={fileUrl(document.id, '?variant=original&download=1')} download>Original<Icon name="download" size={14}/></a>
            </div>
            {!ready && <p className="document-source-hold">The original is preserved. Select this source to see the review hold.</p>}
          </article>;
        })}
      </div>
    </section>;
  }

  return <section className="document-library" aria-labelledby={headingId}>
    <header className="document-library-heading">
      <div><h2 id={headingId}>Originals and prepared versions</h2>
        <p>Finished originals, supporting evidence and the exact versions prepared for each application.</p></div>
      <Button icon="upload" variant="primary" onClick={onImport}>Import resumes</Button>
    </header>
    {demo && <p className="document-fixture-note">Rehearsal documents. These records stay separate from your real workspace.</p>}
    <div className="document-library-layout">
      <aside className="document-library-sources" aria-label="Document selection"><details ref={chooser} className="document-chooser" open={chooserOpen} onToggle={event=>setChooserOpen(event.currentTarget.open)}><summary><span><strong>Choose a document</strong><small>{selected?(packet?owningJob?.title||packet.name||'Application resume':documentName(activeSource)):'Originals and prepared versions'}</small></span><span className="document-chooser-count">{resumes.length+packages.length}</span></summary><div className="document-chooser-list">
        {renderSourceGroup({ title: 'Finished resumes', description: 'Starting points for an application. Every original stays intact.', documents: finished })}
        {renderSourceGroup({ title: 'Evidence-only sources', description: 'Mega resumes support factual matching. They are never the default upload.', documents: evidence })}
        {!resumes.length && <div className="document-library-empty"><Icon name="file" size={25}/><h3>Bring your strongest starting points</h3><p>Import a finished PDF, DOCX, Markdown or text resume. Add a mega resume separately as supporting evidence.</p><Button icon="upload" onClick={onImport}>Import resumes</Button></div>}
        {packages.length > 0 && <section className="document-source-group document-version-group">
          <header><h3>Prepared versions</h3><span>{packages.length}</span></header>
          <p>Each version belongs to its recorded employer and role.</p>
          {packages.map(pkg => {
            const job = jobs.find(item => item.id === pkg.jobId);
            const current = currentPacket(pkg, job, data.profile?.updatedAt);
            const active = activeKey === `package:${pkg.id}`;
            return <article className={`package-row document-version-row${active ? ' is-selected' : ''}`} key={pkg.id}>
              <button className="document-select" type="button" aria-pressed={active}
                onClick={() => selectDocument({ kind: 'package', id: pkg.id })}>
                <Icon name="file" size={20}/><span><strong>{job?.title || pkg.name || 'Application resume'}</strong><small>{job?.employer || 'Owning application unavailable'}</small></span><Icon name="chevron" size={16}/>
              </button>
              <Badge value={pkg.approved && current ? 'ready' : 'needs_you'}>{pkg.approved ? current ? 'Reviewed' : 'Reviewed for an earlier context' : pkg.verified === true ? 'Review needed' : 'Verification required'}</Badge>
              <div className="document-version-actions">
                {pkg.verified === true && <a className="document-text-link" target="_blank" rel="noreferrer" href={fileUrl(pkg.id, '?variant=final')}>Preview document<Icon name="external" size={14}/></a>}
                {job && <button className="document-text-link" type="button" onClick={() => onJob(job.id)}>Open application<Icon name="arrow" size={14}/></button>}
              </div>
              {active ? <Button disabled={pkg.approved || !approvalAllowed(pkg)} busy={approving} onClick={() => onApprove(pkg.id)}>Approve document</Button> : <Button icon="file" onClick={() => selectDocument({kind:'package',id:pkg.id})}>Review document</Button>}
            </article>;
          })}
        </section>}
      </div></details></aside>

      <section className="document-dossier document-library-preview" aria-label="Selected document">
        {selected ? <>
          <header><div><span className="document-eyebrow">{packet ? 'Prepared application resume' : activeSource.mega ? 'Evidence-only source' : 'Finished source'}</span>
            <h3 ref={previewHeading} tabIndex={-1}>{packet ? owningJob?.title || packet.name || 'Application resume' : documentName(activeSource)}</h3>
            {packet && <p>{owningJob?.employer || 'Owning application unavailable'}</p>}</div>
            <Badge value={packet ? packet.approved && packetCurrent ? 'ready' : 'needs_you' : 'neutral'}>{packet ? packet.approved ? packetCurrent ? 'Reviewed' : 'Earlier context' : 'Review needed' : activeSource.mega ? 'Evidence only' : 'Preserved original'}</Badge>
          </header>
          <div className="document-preview-actions">
            {previewReady && <a className="button secondary" target="_blank" rel="noreferrer" href={fileUrl(selected.id, packet ? '?variant=final' : '')}>Preview document<Icon name="external" size={15}/></a>}
            {activeSource && <a className="button secondary" href={fileUrl(activeSource.id, '?variant=original&download=1')} download>Original<Icon name="download" size={15}/></a>}
            {packet && owningJob && <Button icon="arrow" onClick={() => onJob(owningJob.id)}>Open application</Button>}
          </div>
          {packet && !packetCurrent && <p className="document-context-hold">This retained version is outside the current application context. Review the current application before approving a document.</p>}
          {previewReady ? <div className="document-preview-canvas"><PdfPreview key={selected.id} id={selected.id} title={packet ? `${owningJob?.employer || 'Application'} resume` : documentName(activeSource)}/></div>
            : <div className="document-preview-hold" role="status"><Icon name="file" size={30}/><h4>{packet ? 'Document verification required' : previewHold(activeSource)}</h4><p>{packet ? 'This retained version is not verified for preview or approval. Open its application to review the current preparation state.' : 'The original is preserved. A verified preview is not available yet.'}</p>{!packet && activeSource.renderError && <p>{activeSource.renderError}</p>}</div>}
          <div className="document-preview-details">
            {packet && <><h4>Why this version</h4><p>{packet.explanation || packet.reason || 'Retained application-specific version.'}</p><p className="document-source-credit">Source: {activeSource ? documentName(activeSource) : 'Source record unavailable'}{packet.changes?.length ? ` / ${packet.changes.length} supported edits` : ' / retained unchanged'}</p>
              {!packet.approved && <Button variant="primary" disabled={!approvalAllowed(packet)} busy={approving} onClick={() => onApprove(packet.id)}>Approve document</Button>}</>}
            {!packet && activeSource.warnings?.length > 0 && <ul className="document-warnings">{activeSource.warnings.map((warning, index) => <li key={index}>{String(warning)}</li>)}</ul>}
            <details><summary>File identity and source</summary><dl><div><dt>Record</dt><dd>{selected.id}</dd></div><div><dt>Created</dt><dd>{dateLabel(selected.createdAt)}</dd></div><div><dt>SHA-256</dt><dd>{selected.hash || selected.sha256 || 'Not recorded'}</dd></div>{packet && <div><dt>Owning application</dt><dd>{packet.jobId}</dd></div>}</dl></details>
          </div>
        </> : <div className="document-preview-empty"><Icon name="file" size={32}/><h3>Your actual document appears here</h3><p>Import a finished resume to preview its retained PDF. Each application keeps its own exact prepared version.</p></div>}
      </section>
    </div>
  </section>;
}
