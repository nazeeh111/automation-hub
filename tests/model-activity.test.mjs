import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {ModelService} from '../server/model.mjs';

const output={chosenResumeId:'synthetic-resume',edits:[],structureEdits:[],requirements:[],questions:[]};
async function fixture(t,runner){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-model-activity-')),store=new Store(directory);
 store.put('connection',{id:'model',enabled:true,verified:true});
 const model=new ModelService({store,directory,runner});
 t.after(async()=>{await model.close();store.close();await rm(directory,{recursive:true,force:true});});return {store,model,directory};
}
test('live reasoning receipt and reserved allowance become a bounded returned record without retaining inputs or output',async t=>{
 let release;const ctx=await fixture(t,()=>new Promise(resolve=>release=resolve));
 const pending=ctx.model.reason({privatePrompt:'SYNTHETIC_PRIVATE_INPUT'});
 assert.equal(ctx.model.snapshot().busy,true);assert.equal(ctx.model.snapshot().usedCalls,1);
 assert.equal(ctx.model.snapshot().recentAttempts[0].status,'running');
 await assert.rejects(ctx.model.reason({}),e=>e.code==='model_busy');
 release({...output,privateOutput:'SYNTHETIC_PRIVATE_OUTPUT'});await pending;
 const state=ctx.model.snapshot();assert.equal(state.busy,false);assert.equal(state.usedCalls,1);assert.equal(state.remainingCalls,19);assert.equal(state.recentAttempts[0].status,'returned');
 assert.equal(state.recentAttempts[0].outcomeCode,'output_returned');assert(state.recentAttempts[0].endedAt);
 assert(!JSON.stringify(ctx.store.get('usage','model')).includes('SYNTHETIC_PRIVATE'));
});
test('failed requests retain their reservation but never persist arbitrary exception messages or codes',async t=>{
 const ctx=await fixture(t,async()=>{throw Object.assign(new Error('SYNTHETIC_PRIVATE_ERROR'),{code:'SYNTHETIC_PRIVATE_CODE'});});
 await assert.rejects(ctx.model.reason({}),/SYNTHETIC_PRIVATE_ERROR/);
 const usage=ctx.store.get('usage','model');assert.equal(usage.calls,1);assert.equal(usage.recentAttempts[0].status,'failed');assert.equal(usage.recentAttempts[0].outcomeCode,'request_failed');assert(!JSON.stringify(usage).includes('SYNTHETIC_PRIVATE'));
});
test('a failed terminal receipt write cannot turn a rejected request into a returned outcome',async t=>{
 const ctx=await fixture(t,async()=>{throw new Error('Synthetic request failure');}),put=ctx.store.put.bind(ctx.store);let failOnce=true;
 ctx.store.put=(kind,document)=>{if(kind==='usage'&&document.recentAttempts?.at(-1)?.status==='failed'&&failOnce){failOnce=false;throw new Error('Synthetic terminal storage failure');}return put(kind,document);};
 await assert.rejects(ctx.model.reason({}),/Synthetic request failure/);assert.equal(ctx.model.snapshot().usedCalls,1);assert.equal(ctx.model.snapshot().recentAttempts[0].status,'running');
 ctx.store.put=put;ctx.model.recoverInterrupted();assert.equal(ctx.model.snapshot().recentAttempts[0].status,'interrupted');assert.equal(ctx.model.snapshot().recentAttempts[0].outcomeCode,'service_restarted');
});
test('connection checks are explicitly separate, bounded history keeps20 and old usage never invents outcomes',async t=>{
 const ctx=await fixture(t,async()=>output);ctx.store.put('usage',{id:'model',calls:7,lastPurpose:'resume'});
 assert.equal(ctx.model.snapshot().usedCalls,7);assert.deepEqual(ctx.model.snapshot().recentAttempts,[]);
 for(let i=0;i<23;i++)await ctx.model.probe();
 const state=ctx.model.snapshot();assert.equal(state.usedCalls,7);assert.equal(state.recentAttempts.length,20);assert(state.recentAttempts.every(item=>item.purpose==='connection_check'));
 ctx.store.put('campaign',{...ctx.store.get('campaign','main'),rules:{maxReasoningCalls:5}});
 assert.equal(ctx.model.snapshot().remainingCalls,0);await assert.rejects(ctx.model.reason({}),/limit has been reached/);
 assert.equal(ctx.model.snapshot().usedCalls,7);
});
test('restart reconciliation is idempotent, retains allowance and cannot rewrite an active request',async t=>{
 const ctx=await fixture(t,async()=>output);ctx.store.put('usage',{id:'model',calls:3,recentAttempts:[{id:'old',purpose:'resume',status:'running',startedAt:'2026-11-16T00:00:00Z'},{id:'returned',purpose:'writing',status:'returned'}]});
 ctx.model.recoverInterrupted();const first=ctx.store.get('usage','model'),revision=ctx.store.revision();ctx.model.recoverInterrupted();
 assert.equal(ctx.store.revision(),revision);assert.equal(first.calls,3);assert.equal(first.recentAttempts[0].status,'interrupted');assert.equal(first.recentAttempts[0].outcomeCode,'service_restarted');assert.equal(first.recentAttempts[1].status,'returned');
 let release;ctx.model.runner=()=>new Promise(resolve=>release=resolve);const request=ctx.model.reason({});ctx.model.recoverInterrupted();assert.equal(ctx.model.snapshot().recentAttempts[0].status,'running');release(output);await request;
});
test('actual CLI timeout is classified accurately and retains no native output',async t=>{
 const ctx=await fixture(t),command=path.join(ctx.directory,'fixture-cli.mjs'),configDir=path.join(ctx.directory,'codex-home');
 await mkdir(configDir);await writeFile(path.join(configDir,'config.toml'),'model = "synthetic-model"\nmodel_reasoning_effort = "high"\n');
 await writeFile(command,`#!${process.execPath}\nprocess.stdout.write('SYNTHETIC_PRIVATE_STREAM');setInterval(()=>{},1000);`,{mode:0o700});
 const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=configDir;
 t.after(()=>{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;});
 const model=new ModelService({store:ctx.store,directory:ctx.directory,command,timeout:50,authChecker:async()=>({mode:'chatgpt'})});
 await assert.rejects(model.reason({}),e=>e.code==='model_timeout'&&/timed out/.test(e.message));
 const state=model.snapshot();assert.equal(state.usedCalls,1);assert.equal(state.recentAttempts[0].outcomeCode,'model_timeout');assert.equal(state.recentAttempts[0].model,'synthetic-model');assert.equal(state.recentAttempts[0].effort,'high');assert(!JSON.stringify(ctx.store.get('usage','model')).includes('SYNTHETIC_PRIVATE_STREAM'));
 await model.close();
});
test('malformed structured output is rejected without reflecting its private text',async t=>{
 const ctx=await fixture(t),command=path.join(ctx.directory,'fixture-invalid.mjs'),configDir=path.join(ctx.directory,'codex-home');
 await mkdir(configDir);await writeFile(path.join(configDir,'config.toml'),'model = "synthetic-model"\n');
 await writeFile(command,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';const args=process.argv.slice(2);writeFileSync(args[args.indexOf('-o')+1],'SYNTHETIC_PRIVATE_MALFORMED');`,{mode:0o700});
 const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=configDir;t.after(()=>{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;});
 const model=new ModelService({store:ctx.store,directory:ctx.directory,command,authChecker:async()=>({mode:'chatgpt'})});
 await assert.rejects(model.reason({}),e=>e.code==='model_invalid_response'&&!e.message.includes('SYNTHETIC_PRIVATE'));assert.equal(model.snapshot().recentAttempts[0].outcomeCode,'model_invalid_response');await model.close();
});

test('invalid saved usage remains unknown and is held without changing its raw count',async t=>{
 const ctx=await fixture(t,async()=>output);
 for(const calls of [undefined,-1,'7',null]){ctx.store.put('usage',{id:'model',calls});const before=ctx.store.get('usage','model'),state=ctx.model.snapshot();assert.equal(state.usedCalls,null);assert.equal(state.remainingCalls,null);assert.equal(state.usageValid,false);await assert.rejects(ctx.model.reason({}),/saved reasoning usage needs review/);assert.deepEqual(ctx.store.get('usage','model'),before);}
});

test('valid JSON null is a typed invalid result, not a raw property error',async t=>{
 const ctx=await fixture(t),command=path.join(ctx.directory,'fixture-null.mjs'),configDir=path.join(ctx.directory,'codex-home');
 await mkdir(configDir);await writeFile(path.join(configDir,'config.toml'),'model = "synthetic-model"\n');
 await writeFile(command,`#!${process.execPath}\nimport {writeFileSync} from 'node:fs';const args=process.argv.slice(2);writeFileSync(args[args.indexOf('-o')+1],'null');`,{mode:0o700});
 const previous=process.env.CODEX_HOME;process.env.CODEX_HOME=configDir;t.after(()=>{if(previous===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous;});
 const model=new ModelService({store:ctx.store,directory:ctx.directory,command,authChecker:async()=>({mode:'chatgpt'})});await assert.rejects(model.reason({}),e=>e.code==='model_invalid_response'&&!e.message.includes('TypeError'));assert.equal(model.snapshot().recentAttempts[0].outcomeCode,'model_invalid_response');await model.close();
});
