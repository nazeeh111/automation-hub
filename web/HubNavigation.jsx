import React, {useEffect, useRef, useState} from 'react';

const sections=[['discover','Discover'],['applications','Applications'],['resumes','Résumés'],['outcomes','Outcomes'],['settings','Settings']];

export default function HubNavigation({page, ready, switching, offline, attentionCount, onPage, onSearch, onRefresh, workspaceNavigation, section, onSection, sectionCounts, Icon}) {
  const disabled = !ready || switching;
  const [folded,setFolded]=useState(()=>window.matchMedia('(max-width:1099px)').matches),[navOpen,setNavOpen]=useState(false);
  const navigation=useRef(null),menuTrigger=useRef(null);
  const closeNavigation=()=>{setNavOpen(false);menuTrigger.current?.focus();};
  const navigate=destination=>{onPage(destination);closeNavigation();};
  const openSection=value=>{onPage('workspace');onSection(value);closeNavigation();};
  useEffect(()=>{const media=window.matchMedia('(max-width:1099px)'),change=()=>{setFolded(media.matches);setNavOpen(false);};media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
  useEffect(()=>{
    if(!folded||!navOpen)return;
    const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    const controls=()=>[...navigation.current.querySelectorAll('button:not(:disabled),a[href],select')].filter(element=>element.getClientRects().length);
    controls()[0]?.focus();
    const keydown=event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeNavigation();}else if(event.key==='Tab'){const items=controls(),first=items[0],last=items.at(-1);if(!navigation.current.contains(document.activeElement)){event.preventDefault();first?.focus();}else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};
    document.addEventListener('keydown',keydown,true);return()=>{document.body.style.overflow=previousOverflow;document.removeEventListener('keydown',keydown,true);};
  },[folded,navOpen]);
  const screen=page==='workspace'?sections.find(([id])=>id===section)?.[1]||'Internships':({home:'Home',automations:'Automations',needs:'Needs You',connections:'Connections'}[page]||'Workspace');
  return <>
    <header className="topbar studio-topbar">
      <button ref={menuTrigger} type="button" className="icon-button studio-menu-trigger" aria-label="Open navigation" aria-expanded={navOpen} aria-controls="hub-navigation" disabled={disabled} onClick={()=>setNavOpen(true)}><Icon name="grid" size={18}/></button>
      <div className="studio-location"><span className="studio-phone-product">Automation Hub</span><span>Private workspace</span><i aria-hidden="true">/</i><strong>{screen}</strong></div>
      <div className="studio-header-tools">
        <button className="workspace-search-trigger" disabled={disabled} onClick={onSearch} aria-label="Find in your workspace"><Icon name="search" size={16}/><span>Find in workspace</span><kbd>⌘ K</kbd></button>
        <span className={`connection-state ${offline ? 'is-offline' : ''}`}><i/>{offline ? 'Connection lost' : 'Saved locally'}</span>
        <button className="icon-button" onClick={onRefresh} aria-label="Refresh dashboard"><Icon name="refresh" size={16}/></button>
      </div>
    </header>
    {folded&&navOpen&&<button type="button" className="studio-nav-scrim" tabIndex={-1} aria-label="Close navigation" onClick={closeNavigation}/>}
    <aside ref={navigation} id="hub-navigation" className={`sidebar studio-context ${page==='workspace'?'is-workspace':''} ${navOpen?'is-open':''}`} inert={disabled||(folded&&!navOpen)?true:undefined} role={folded&&navOpen?'dialog':undefined} aria-modal={folded&&navOpen?true:undefined} aria-label="Workspace navigation">
      <div className="studio-brand-row"><button className="brand" aria-label="Automation hub home" disabled={disabled} onClick={()=>navigate('home')}>
        <svg className="brand-symbol" width="25" height="25" viewBox="0 0 28 28" fill="none" aria-hidden="true"><rect x="2.5" y="3.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="17.5" y="16.5" width="8" height="8" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M10.5 7.5H17a4 4 0 0 1 4 4v5M6.5 11.5V20a.5.5 0 0 0 .5.5h10.5" stroke="currentColor" strokeWidth="1.5"/></svg>
        <span>Automation Hub</span>
      </button><button type="button" className="icon-button studio-menu-close" aria-label="Close navigation" onClick={closeNavigation}>×</button></div>
      <nav className="global-navigation" aria-label="Main navigation">
        {[['home','home','Home'],['automations','grid','Automations'],['needs','inbox','Needs You']].map(([key, icon, name]) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-label={name} aria-current={page === key ? 'page' : undefined} onClick={() => navigate(key)}><Icon name={icon} size={17}/><span>{name}</span>{key === 'needs' && attentionCount > 0 && <b className="nav-count">{attentionCount}</b>}</button>)}
      </nav>
      <div className="studio-workspace-name"><span>Internships<small>Application workspace</small></span></div>
      <div className="studio-workspace-navigation" onClickCapture={event=>{if(event.target.closest('button')){onPage('workspace');closeNavigation();}}}>{workspaceNavigation}</div>
      <label className="studio-mobile-section"><span>Internships</span><select aria-label="Internship section" value={section} onChange={event=>openSection(event.target.value)}>{sections.map(([id,name])=><option key={id} value={id}>{name}{sectionCounts?.[id]!==undefined?` (${sectionCounts[id]})`:''}</option>)}</select></label>
      <div className="studio-context-foot"><button className={`studio-connection-link ${page==='connections'?'selected':''}`} disabled={disabled} onClick={()=>navigate('connections')} aria-label="Open Connections"><Icon name="settings" size={17}/><span>Connections</span></button><span className="studio-private-caption"><Icon name="lock" size={13}/><span>Private on this Mac</span></span></div>
    </aside>
  </>;
}
