import React from 'react';

// Display recovery never repeats the request or action that preceded a failure.
export default class RecoveryBoundary extends React.Component {
  state = {failed:false};
  heading=React.createRef();
  componentDidCatch(){
    this.heading.current?.focus();
    if(this.props.nativeRoot){const generation=window.__hubLaunchGeneration;if(typeof generation==='string'){try{window.webkit?.messageHandlers?.hub?.postMessage({action:'workspaceReady',generation});}catch{}}}
  }
  static getDerivedStateFromError() { return {failed:true}; }
  render() {
    if(!this.state.failed)return this.props.children;
    return <section className={`view-recovery ${this.props.onExit ? 'view-recovery-panel' : ''}`} role="alert" aria-label="View recovery">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M12 8v5m0 3v1"/><circle cx="12" cy="12" r="9"/></svg>
      <h1 ref={this.heading} tabIndex={-1}>{this.props.title || 'The workspace could not be displayed'}</h1>
      <p>Your saved work remains on this Mac. Reopening a view does not repeat an application or other action. Unsaved input inside the failed view may need to be entered again.</p>
      <div className="button-group"><button className="button primary" type="button" onClick={() => this.setState({failed:false})}>Reopen view</button>{this.props.onExit ? <button className="button secondary" type="button" onClick={this.props.onExit}>{this.props.exitLabel || 'Close view'}</button> : <button className="button secondary" type="button" onClick={() => window.location.reload()}>Reload workspace</button>}</div>
    </section>;
  }
}
