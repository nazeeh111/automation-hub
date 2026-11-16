import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,chmod,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../server/store.mjs';
import {ModelService,nativeCodexAuthStatus} from '../server/model.mjs';

async function fixture(t,runner){
 const directory=await mkdtemp(path.join(tmpdir(),'hub-writing-model-')),store=new Store(directory);
 store.put('connection',{id:'model',enabled:true,verified:true});
 store.put('campaign',{...store.get('campaign','main'),rules:{maxReasoningCalls:2}});
 t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
 return {directory,store,model:new ModelService({store,directory,runner})};
}
const prose={sentences:[{text:'I built a simulated sensor prototype.',sourceIds:['fact-synthetic']}],missingFacts:[],explanation:'Draft for human review.'};
test('resume comparison and writing share the same persisted configured call budget',async t=>{
 const inputs=[],ctx=await fixture(t,async input=>{inputs.push(input);return input.task==='draftWriting'?prose:{chosenResumeId:'synthetic',edits:[],questions:[],requirements:[]};});
 await ctx.model.reason({resumes:[]});assert.deepEqual(await ctx.model.draftWriting({question:{label:'Describe a prototype'}}),prose);
 assert.equal(inputs[1].task,'draftWriting');assert.equal(ctx.store.get('usage','model').calls,2);assert.equal(ctx.store.get('usage','model').lastPurpose,'writing');
 await assert.rejects(ctx.model.draftWriting({}),e=>e.code==='model_unavailable');assert.equal(inputs.length,2);
});
test('a concurrent writing request cannot bypass serialization or consume another allowance',async t=>{
 let finish,entered;const started=new Promise(resolve=>entered=resolve);const ctx=await fixture(t,async()=>{entered();return new Promise(resolve=>finish=resolve);});
 const first=ctx.model.draftWriting({});await started;
 await assert.rejects(ctx.model.draftWriting({}),e=>e.code==='model_busy');assert.equal(ctx.store.get('usage','model').calls,1);
 finish(prose);await first;assert.equal(ctx.model.busy,false);
});
test('writing remains unavailable until the existing reasoning connection is enabled and checked',async t=>{
 let calls=0;const ctx=await fixture(t,async()=>{calls++;return prose;});ctx.store.put('connection',{id:'model',enabled:false,verified:true});
 await assert.rejects(ctx.model.draftWriting({}),e=>e.code==='model_unavailable');assert.equal(calls,0);assert.equal(ctx.store.get('usage','model'),null);
});
test('actual CLI dispatch uses a separate strict writing schema and the existing restricted process controls',async t=>{
 const ctx=await fixture(t),record=path.join(ctx.directory,'invocation.json'),command=path.join(ctx.directory,'fixture-cli.mjs');
 const previousCodexHome=process.env.CODEX_HOME,fixtureCodexHome=path.join(ctx.directory,'codex-home');
 await mkdir(fixtureCodexHome);await writeFile(path.join(fixtureCodexHome,'config.toml'),'model = "synthetic-writing-model"\nmodel_reasoning_effort = "high"\nmodel_provider = "openai"\n');
 process.env.CODEX_HOME=fixtureCodexHome;
 t.after(()=>{if(previousCodexHome===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previousCodexHome;});
 const code=`#!${process.execPath}\nimport {readFileSync,writeFileSync} from 'node:fs';if(process.argv[2]==='login'){process.stderr.write('Logged in using ChatGPT');process.exit(0);}let prompt='';for await(const chunk of process.stdin)prompt+=chunk;const args=process.argv.slice(2);writeFileSync(${JSON.stringify(record)},JSON.stringify({args,prompt,schema:JSON.parse(readFileSync(args[args.indexOf('--output-schema')+1],'utf8'))}));writeFileSync(args[args.indexOf('-o')+1],${JSON.stringify(JSON.stringify(prose))});`;
 await writeFile(command,code,{mode:0o700});await chmod(command,0o700);
 const model=new ModelService({store:ctx.store,directory:ctx.directory,command});await model.draftWriting({question:{label:'Describe a prototype'},sourceCatalog:[{id:'fact-synthetic',text:'Built a simulated sensor prototype.'}]});
 const actual=JSON.parse(await readFile(record,'utf8'));
 assert.deepEqual(actual.schema.required,['sentences','missingFacts','explanation']);assert.equal(actual.schema.additionalProperties,false);
 assert(actual.args.includes('--ignore-user-config'));assert(actual.args.includes('--ephemeral'));assert(actual.args.includes('read-only'));assert(actual.args.includes('code_mode_host'));assert(actual.args.includes('shell_tool'));
 assert.equal(actual.args[actual.args.indexOf('-m')+1],'synthetic-writing-model');
 assert.match(actual.prompt,/requiring the candidate.s factual and wording review/);assert.match(actual.prompt,/Never convert a project into employment/);assert.match(actual.prompt,/"task":"draftWriting"/);
 assert(!actual.schema.properties.chosenResumeId);
});
test('native API-key and unknown authentication stop before inference without disclosing native status output',async t=>{
 const ctx=await fixture(t),command=path.join(ctx.directory,'status-only-cli.mjs');
 await writeFile(command,`#!${process.execPath}\nif(process.argv[2]==='login'){process.stderr.write('Logged in using an API key: SYNTHETIC_PRIVATE_STATUS_MARKER');process.exit(0);}throw new Error('Inference must never run');`,{mode:0o700});
 const classified=await nativeCodexAuthStatus({command});assert.deepEqual(classified,{mode:'api_key'});
 const model=new ModelService({store:ctx.store,directory:ctx.directory,command});await assert.rejects(model.probe(),error=>error.code==='model_unavailable'&&!error.message.includes('SYNTHETIC_PRIVATE_STATUS_MARKER'));
 const connection=ctx.store.get('connection','model');assert.equal(connection.verified,false);assert.equal(connection.authMode,'api_key');assert(!JSON.stringify(connection).includes('SYNTHETIC_PRIVATE_STATUS_MARKER'));
 const unknown=new ModelService({store:ctx.store,directory:ctx.directory,command,authChecker:async()=>({mode:'unknown'})});await assert.rejects(unknown.probe(),error=>error.code==='model_unavailable');assert.equal(ctx.store.get('connection','model').authMode,'unknown');
});
test('native status classification is bounded and returns no raw output for an unrecognized response',async t=>{
 const ctx=await fixture(t),command=path.join(ctx.directory,'oversized-status.mjs');await writeFile(command,`#!${process.execPath}\nprocess.stderr.write('x'.repeat(10000));`,{mode:0o700});
 assert.deepEqual(await nativeCodexAuthStatus({command}),{mode:'unknown'});
});
