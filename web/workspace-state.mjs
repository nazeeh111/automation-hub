// One acceptance order for polling and explicit real/fixture transitions.
// The UI must not admit writes while the cookie's workspace is uncertain.
export function createWorkspaceState({initialState,fetcher=fetch,onSnapshot=()=>{},onStatus=()=>{},onError=()=>{}}){
  let sequence=0,contextEpoch=0,transition=null,etag=null,snapshot=initialState,ready=false,offline=false,loaded=false;
  const status=()=>onStatus({ready,offline,loaded,transitioning:Boolean(transition)});
  const publish=value=>{
    if(!value||typeof value!=='object'||typeof value.demo!=='boolean')throw new Error('The server did not identify the current workspace. Refresh before continuing.');
    const previous=snapshot;if(typeof previous.demo==='boolean'&&previous.demo!==value.demo)contextEpoch++;snapshot={...initialState,...value};ready=true;offline=false;loaded=true;onSnapshot(snapshot,previous);status();return snapshot;
  };
  return {
    canMutate:()=>ready&&!transition,
    current:()=>snapshot,
    capture(){if(!ready||transition)throw new Error('Reconnect to confirm the current workspace before making changes.');return {epoch:contextEpoch,demo:snapshot.demo};},
    assertCurrent(binding){if(!binding||!ready||transition||binding.epoch!==contextEpoch||binding.demo!==snapshot.demo)throw new Error('The workspace changed or needs reconnecting. Review its saved state before trying this action again.');},
    requireConfirmation(){contextEpoch++;sequence++;etag=null;ready=false;offline=true;loaded=true;status();},
    beginTransition(){if(transition)throw new Error('Wait for the workspace switch to finish.');contextEpoch++;sequence++;etag=null;ready=false;transition=Symbol('workspace');status();return transition;},
    acceptTransition(token,value,expectedDemo){
      if(token!==transition)return null;
      if(value?.demo!==expectedDemo)throw new Error('The workspace switch was not confirmed. Reconnect before continuing.');
      sequence++;transition=null;etag=null;return publish(value);
    },
    recoverTransition(token){if(token!==transition)return;contextEpoch++;sequence++;transition=null;etag=null;ready=false;offline=true;loaded=true;status();},
    async refresh(){
      if(transition)return snapshot;
      const request=++sequence;
      try{
        const response=await fetcher('/api/state',{credentials:'same-origin',headers:etag?{'If-None-Match':etag}:{}});
        if(request!==sequence||transition){try{await response.body?.cancel?.();}catch{}return snapshot;}
        if(response.status===304){if(!ready)throw new Error('Reconnect to confirm the current workspace.');offline=false;loaded=true;status();return snapshot;}
        const value=await response.json();
        if(request!==sequence||transition)return snapshot;
        if(!response.ok)throw new Error(value.message||value.error||'The workspace could not be loaded.');
        const result=publish(value);etag=response.headers.get('etag');return result;
      }catch(error){
        if(request!==sequence||transition)return snapshot;
        etag=null;ready=false;offline=true;loaded=true;status();onError(error);return null;
      }
    }
  };
}
