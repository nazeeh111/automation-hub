import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkspaceState} from '../web/workspace-state.mjs';
const reply=(demo,tag='tag')=>new Response(JSON.stringify({demo,jobs:demo?['fixture']:['real']}),{headers:{etag:tag}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
test('newer accepted state and ETag cannot be replaced by an older successful refresh',async()=>{
 const a=deferred(),b=deferred(),requests=[];let count=0;const c=createWorkspaceState({initialState:{jobs:[]},fetcher:async(_url,options)=>{requests.push(options);return ++count===1?a.promise:count===2?b.promise:new Response(null,{status:304});}});
 const first=c.refresh(),second=c.refresh();b.resolve(reply(true,'new'));await second;a.resolve(reply(false,'old'));await first;assert.equal(c.current().demo,true);await c.refresh();assert.equal(requests[2].headers['If-None-Match'],'new');
});
test('late failed refresh does not revoke a newer accepted snapshot',async()=>{
 const a=deferred();let count=0,errors=0;const c=createWorkspaceState({initialState:{},fetcher:()=>++count===1?a.promise:Promise.resolve(reply(true)),onError:()=>errors++});const first=c.refresh();await c.refresh();a.reject(new Error('late error'));await first;assert.equal(c.canMutate(),true);assert.equal(errors,0);
});
test('switch response commits exact context and fences in-flight polls',async()=>{
 const a=deferred();let count=0;const c=createWorkspaceState({initialState:{},fetcher:()=>++count===1?Promise.resolve(reply(false)):a.promise});await c.refresh();const old=c.refresh(),token=c.beginTransition();assert.equal(c.canMutate(),false);await c.refresh();c.acceptTransition(token,{demo:true,jobs:['fixture']},true);a.resolve(reply(false));await old;assert.equal(c.current().demo,true);assert.equal(c.canMutate(),true);assert.equal(count,2);
});
test('lost switch reply remains read only through failed recovery and permits fresh actual-context recovery',async()=>{
 let mode=0;const c=createWorkspaceState({initialState:{},fetcher:async()=>{if(mode===1)throw new Error('offline');return reply(mode===2);}});await c.refresh();const token=c.beginTransition();c.recoverTransition(token);mode=1;await c.refresh();assert.equal(c.canMutate(),false);assert.equal(c.current().demo,false);mode=2;await c.refresh();assert.equal(c.canMutate(),true);assert.equal(c.current().demo,true);
});
test('unidentified or mismatched workspace responses never admit mutations',async()=>{
 const c=createWorkspaceState({initialState:{},fetcher:async()=>new Response('{}')});await c.refresh();assert.equal(c.canMutate(),false);const t=c.beginTransition();assert.throws(()=>c.acceptTransition(t,{demo:false},true),/not confirmed/);assert.equal(c.canMutate(),false);c.recoverTransition(t);
});
test('a captured user intent survives ordinary same-workspace refresh but not another workspace',async()=>{
 let demo=false;const c=createWorkspaceState({initialState:{},fetcher:async()=>reply(demo)});await c.refresh();const scope=c.capture();await c.refresh();assert.doesNotThrow(()=>c.assertCurrent(scope));demo=true;await c.refresh();assert.throws(()=>c.assertCurrent(scope),/workspace changed/);assert.equal(scope.demo,false);assert.equal(c.capture().demo,true);
});
test('a real-fixture-real transition cannot revive an earlier captured file-read intent',async()=>{
 const c=createWorkspaceState({initialState:{},fetcher:async()=>reply(false)});await c.refresh();const intent=c.capture();let token=c.beginTransition();c.acceptTransition(token,{demo:true},true);token=c.beginTransition();c.acceptTransition(token,{demo:false},false);assert.equal(c.current().demo,false);assert.throws(()=>c.assertCurrent(intent),/workspace changed/);
});
test('a required reconfirmation invalidates a prior user intent even after same-workspace recovery',async()=>{
 const c=createWorkspaceState({initialState:{},fetcher:async()=>reply(false)});await c.refresh();const intent=c.capture();c.requireConfirmation();await c.refresh();assert.throws(()=>c.assertCurrent(intent),/workspace changed/);assert.doesNotThrow(()=>c.assertCurrent(c.capture()));
});
