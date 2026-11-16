import React, {useLayoutEffect, useRef, useState} from 'react';
import './decision-workspace.css';
const reviewType=item=>({package_review:'Document review',document_review:'Document review',eligibility_review:'Eligibility',requirement_review:'Requirements',posting_changed:'Source change',missing_fact:'Candidate facts',form_questions:'Employer questions',account_access:'Employer access',account_verification:'Email verification',account_consent:'Employer consent',supporting_document:'Supporting document',supporting_review:'Supporting document',writing_review:'Written answer',uncertain_submission:'Receipt reconciliation',submission_uncertain:'Receipt reconciliation',verification:'Email verification'}[item.code||item.type||item.attentionKind]||'Saved review');

export default function DecisionWorkspace({items, jobs, activeId, onSelect, children, Icon}) {
  const panels=useRef(null), list=useRef(null), [listRequested,setListRequested]=useState(false);
  const selected=items.some(item=>item.id===activeId)?activeId:items[0]?.id;
  useLayoutEffect(()=>{setListRequested(false);},[activeId]);
  // Existing exact-context forms stay mounted, including their selected File objects.
  // This component owns only their visibility; it never copies answers or authority.
  useLayoutEffect(()=>{for(const panel of panels.current?.querySelectorAll('[data-attention-id]')||[]){panel.hidden=panel.dataset.attentionId!==selected;panel.inert=panel.hidden;}});
  if(!items.length)return children;
  return <div className={`decision-workspace ${activeId&&!listRequested?'show-question':'show-list'}`}>
    <aside className="decision-work-list" aria-label="Saved questions" ref={list}>
      <div className="decision-work-list-heading"><h2>Saved questions</h2><span>{items.length}</span></div>
      <nav aria-label="Choose a saved question">{items.map(item=>{
        const job=jobs.find(job=>job.id===(item.jobId||item.applicationId||item.attention?.jobId));
        return <button type="button" key={item.id} aria-pressed={selected===item.id} data-question-id={item.id} onClick={()=>{setListRequested(false);onSelect(item.id);}}>
          {item.attention?.label&&<span className="decision-work-urgency">{item.attention.label}</span>}
          <strong>{item.title||item.question||'Review a saved question'}</strong>
          <small>{[job?.employer,job?.title].filter(Boolean).join(' / ')||item.reason||'Workspace review'}</small>
          <span className="decision-work-type">{reviewType(item)}</span>
        </button>;
      })}</nav>
    </aside>
    <section className="decision-work-detail" aria-label="Active saved question" ref={panels}>
      <button className="decision-back-to-list" type="button" onClick={()=>{setListRequested(true);requestAnimationFrame(()=>{const target=list.current?.querySelector(`[data-question-id="${CSS.escape(selected)}"]`);target?.focus();});}}><Icon name="chevron" size={16}/>All saved questions</button>
      {children}
    </section>
  </div>;
}
