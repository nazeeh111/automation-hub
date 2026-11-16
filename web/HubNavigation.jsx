import React from 'react';

export default function HubNavigation({page, ready, switching, offline, attentionCount, onPage, onSearch, onRefresh, workspaceNavigation, section, onSection, sectionCounts, Icon}) {
  const disabled = !ready || switching;
  return <>
    <header className="topbar studio-topbar">
      <button className="brand" aria-label="Automation hub home" disabled={disabled} onClick={() => onPage('home')}>
        <svg className="brand-symbol" width="27" height="27" viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="17.5" y="16.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M10.5 7.5H17a4 4 0 0 1 4 4v5M6.5 11.5V20a.5.5 0 0 0 .5.5h10.5" stroke="currentColor" strokeWidth="1.5"/></svg>
        <span>Automation Hub</span>
      </button>
      <nav className="global-navigation" aria-label="Main navigation" inert={disabled ? true : undefined}>
        {[['home','home','Home'],['automations','grid','Automations'],['needs','inbox','Needs You']].map(([key, icon, name]) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-label={name} aria-current={page === key ? 'page' : undefined} onClick={() => onPage(key)}><Icon name={icon} size={18}/><span>{name}</span>{key === 'needs' && attentionCount > 0 && <b className="nav-count">{attentionCount}</b>}</button>)}
      </nav>
      <div className="studio-header-tools">
        <button className="workspace-search-trigger" disabled={disabled} onClick={onSearch} aria-label="Find in your workspace"><Icon name="search" size={17}/><span>Find in workspace</span><kbd>⌘ K</kbd></button>
        <span className={`connection-state ${offline ? 'is-offline' : ''}`}><i/>{offline ? 'Connection lost' : 'Saved locally'}</span>
        <button className="icon-button" onClick={onRefresh} aria-label="Refresh dashboard"><Icon name="refresh" size={17}/></button>
        <button className={`icon-button studio-connections ${page === 'connections' ? 'selected' : ''}`} disabled={disabled} onClick={() => onPage('connections')} aria-label="Open Connections"><Icon name="settings" size={18}/></button>
      </div>
    </header>
    {page === 'workspace' && <aside className="sidebar studio-context" inert={disabled ? true : undefined} aria-label="Internship workspace navigation">
      <div className="studio-workspace-name"><Icon name="briefcase" size={20}/><span>Internships<small>Application workspace</small></span></div>
      <label className="studio-mobile-section"><span>Internships</span><select aria-label="Internship section" value={section} onChange={event=>onSection(event.target.value)}>{[['discover','Discover'],['applications','Applications'],['resumes','Resumes'],['outcomes','Outcomes'],['settings','Settings']].map(([id,name])=><option key={id} value={id}>{name}{sectionCounts?.[id]!==undefined?` (${sectionCounts[id]})`:''}</option>)}</select></label>
      {workspaceNavigation}
      <div className="studio-context-foot"><Icon name="lock" size={15}/><span>Private on this Mac</span></div>
    </aside>}
  </>;
}
