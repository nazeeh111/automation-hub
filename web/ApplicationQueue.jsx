import React, {useLayoutEffect, useRef} from 'react';
import {applicationPage, applicationResults, matchesApplicationFilter} from './application-view.mjs';

const label = value => String(value || '').replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase());
const when = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString([], {month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}) : 'Not recorded';
const views = [['all','All applications'], ['held','Waiting or held'], ['prepared','Prepared'], ['confirmed','Confirmed receipts']];

export default function ApplicationQueue({jobs, packages, query, filter, sort, offset, selectedId, onQuery, onFilter, onSort, onOffset, onSelect, onPrepare, onImport, onDiscover, busy, Icon, Button, Badge, packageCurrent = () => true}) {
  const results = applicationResults(jobs, {query, filter, sort});
  const page = applicationPage(results, {offset, selectedId});
  const heading = useRef(null), pageIntent = useRef(false);
  useLayoutEffect(() => { if (offset !== page.offset) onOffset(page.offset); }, [offset, page.offset, onOffset]);
  useLayoutEffect(() => { if (pageIntent.current) { pageIntent.current = false; heading.current?.scrollIntoView({block:'start'}); heading.current?.focus({preventScroll:true}); } }, [page.offset]);
  const pageTo = next => { pageIntent.current = true; onSelect(null); onOffset(next); };
  const clear = () => { onQuery(''); onFilter('all'); };
  return <div className="application-queue">
    {jobs.length > 0 && <div className="queue-views" role="group" aria-label="Application work views">{views.map(([value, name]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => onFilter(value)}><span>{name}</span><span className="queue-view-count">{jobs.filter(job => matchesApplicationFilter(job, value)).length.toLocaleString()}</span></button>)}</div>}
    <div className="workspace-toolbar queue-toolbar">
      <label className="search-field"><Icon name="search" size={18}/><input type="search" aria-label="Search applications" placeholder="Find a role or employer" value={query} onChange={event => onQuery(event.target.value)}/></label>
      <select aria-label="Filter application status" value={filter} onChange={event => onFilter(event.target.value)}><option value="all">All applications ({jobs.length})</option><option value="preparation">Awaiting preparation</option><option value="held">Waiting or held ({jobs.filter(job=>matchesApplicationFilter(job,'held')).length})</option><option value="prepared">Prepared ({jobs.filter(job=>matchesApplicationFilter(job,'prepared')).length})</option><option value="ended">Closed or cancelled</option><option value="confirmed">Confirmed receipts ({jobs.filter(job=>matchesApplicationFilter(job,'confirmed')).length})</option><option value="attested">Candidate-attested</option>{['imported','preparing','needs_you','ready','applying','uncertain','manual','submitted','interview','assessment','rejected','offer','failed','closed','cancelled'].map(state => <option value={state} key={state}>{label(state)}</option>)}</select>
      <select aria-label="Sort applications" value={sort} onChange={event => onSort(event.target.value)}><option value="recent">Last updated</option><option value="attention">Attention first</option><option value="deadline">Known deadline</option><option value="employer">Employer A–Z</option></select>
      <div className="queue-actions"><Button onClick={onPrepare} busy={busy === 'prepare'} disabled={!jobs.length}>Prepare queue</Button><Button variant="primary" icon="plus" onClick={onImport}>Import jobs</Button></div>
    </div>
    <div className="queue-result-bar"><p ref={heading} tabIndex={-1} role="status" aria-live="polite">{page.total ? `Showing ${page.offset + 1}–${page.end} of ${page.total.toLocaleString()} application${page.total === 1 ? '' : 's'}` : jobs.length ? 'No matching applications' : 'No selected applications'}</p></div>
    {sort === 'deadline' && <p className="queue-sort-note">Known dates come first. Missing or uncertain deadlines remain below; verify the posting before relying on a date.</p>}
    {page.total > 0 ? <div className="application-table"><div className="table-head"><span>Opportunity</span><span>Document</span><span>Status / next action</span><span>Updated</span><span/></div>{page.items.map(job => {
      const pkg = packages.find(item => item.id === job.packageId), current = pkg && packageCurrent(job, pkg);
      return <button type="button" key={job.id} data-job-id={job.id} className={`application-row ${selectedId === job.id ? 'is-selected' : ''}`} aria-pressed={selectedId === job.id} onClick={() => onSelect(job.id)}>
        <span className="opportunity"><span className="employer-monogram">{String(job.employer || '?').slice(0,1).toUpperCase()}</span><span><strong>{job.title || 'Posting awaiting verification'}</strong><small>{job.employer || 'Employer not verified'}{job.portal ? ` / ${label(job.portal)}` : ''}</small>{(job.deadlineLabel || job.deadline) && <span className="deadline">Deadline {job.deadlineLabel || when(job.deadline)}{job.deadlineUncertain ? ' / date needs review' : ''}</span>}</span></span>
        <span className="document-cell"><Icon name="file" size={16}/><span>{pkg ? !current ? 'Prepare current version' : pkg.verified ? 'Verified package' : 'Check required' : 'Not prepared'}<small>{pkg ? `${pkg.verification?.pages || '?'} page${pkg.verification?.pages === 1 ? '' : 's'} / ${pkg.approved && current ? 'reviewed' : 'review needed'}` : 'Source not selected'}</small></span></span>
        <span className="status-action"><Badge value={job.state}/><small>{job.nextAction || 'Read and verify posting'}</small></span><span className="row-date">{when(job.updatedAt || job.createdAt)}</span><Icon name="chevron" size={17}/>
      </button>;
    })}</div> : <div className="empty"><div className="empty-icon"><Icon name={jobs.length ? 'search' : 'briefcase'} size={29}/></div><h3>{jobs.length ? 'No matching applications' : 'Choose your next internships'}</h3><p>{jobs.length ? 'Try another employer, role or status.' : 'Browse public employer sources or bring your own links. Every selected role gets a saved status and next action.'}</p>{jobs.length ? <Button onClick={clear}>Clear filters</Button> : <div className="button-group"><Button icon="search" variant="primary" onClick={onDiscover}>Browse jobs</Button><Button icon="plus" onClick={onImport}>Import job links</Button></div>}</div>}
    {page.total > page.size && <nav className="queue-pagination" aria-label="Application result pages"><Button disabled={page.offset === 0} onClick={() => pageTo(page.offset - page.size)}>Previous applications</Button><span>Page {Math.floor(page.offset / page.size) + 1} of {Math.ceil(page.total / page.size)}</span><Button disabled={page.end >= page.total} onClick={() => pageTo(page.offset + page.size)}>Next applications</Button></nav>}
    <div className="workspace-footnote"><Icon name="lock" size={15}/><span>A click is never counted as a submission. Confirmation evidence is required.</span></div>
  </div>;
}
