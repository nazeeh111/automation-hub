import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,rename,cp,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createHub} from '../server/index.mjs';
import {Store} from '../server/store.mjs';

test('API backup excludes only its transient worker lease and restores after the original host worker closes',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'hub-backup-worker-'));let hub=await createHub({directory,port:0});t.after(async()=>{await hub.close();await rm(directory,{recursive:true,force:true});});let ctx=hub.context(false);clearInterval(ctx.engine.timer);ctx.engine.timer=null;
 const imported=await ctx.resumes.import([{name:'Synthetic restore.md',content:Buffer.from('# Synthetic Candidate\n\n## Projects\n### Controlled prototype\n- Built a simulated Python sensor in controlled tests.').toString('base64')}]);assert.deepEqual(imported.errors,[]);const original=ctx.store.list('resume')[0],originalBytes=await readFile(original.originalPath),previewBytes=await readFile(original.previewPath);
 ctx.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('synthetic-durable-note','Preserve this unrelated metadata');const before=ctx.store.db.prepare('SELECT key,value FROM metadata ORDER BY key').all(),worker=before.find(row=>row.key==='worker');assert(worker);await assert.rejects(ctx.store.backup(path.join(ctx.dir,'hub.sqlite')),error=>error.status===400);const alias=path.join(directory,'synthetic-source-alias.sqlite');await symlink(path.join(ctx.dir,'hub.sqlite'),alias);await assert.rejects(ctx.store.backup(alias),error=>error.status===400);const observer=new Store(ctx.dir);assert.throws(()=>observer.acquireWorker('second-owner'),/Another hub worker/);observer.close();
 const auth=await fetch(hub.launchUrl,{redirect:'manual'}),cookie=auth.headers.get('set-cookie').split(';')[0],response=await fetch(hub.baseUrl+'/api/action',{method:'POST',headers:{Cookie:cookie,Origin:hub.baseUrl,'X-Hub-Workspace':'real','Content-Type':'application/json'},body:JSON.stringify({action:'backup'})});assert.equal(response.status,200);const result=await response.json(),backupDirectory=path.join(directory,'backups',result.name);
 assert.equal(ctx.store.db.prepare("SELECT value FROM metadata WHERE key='worker'").get().value,worker.value);const currentObserver=new Store(ctx.dir);assert.throws(()=>currentObserver.acquireWorker('still-second-owner'),/Another hub worker/);currentObserver.close();
 const copied=new DatabaseSync(path.join(backupDirectory,'hub.sqlite'),{readOnly:true}),copiedMetadata=copied.prepare('SELECT key,value FROM metadata ORDER BY key').all();copied.close();
 await hub.close();const closed=new Store(path.join(directory,'live'));assert.equal(closed.db.prepare("SELECT value FROM metadata WHERE key='worker'").get(),undefined);closed.close();
 await rename(path.join(directory,'live'),path.join(directory,'preserved-original-live'));await cp(backupDirectory,path.join(directory,'live'),{recursive:true});hub=await createHub({directory,port:0});ctx=hub.context(false);clearInterval(ctx.engine.timer);ctx.engine.timer=null;
 assert.deepEqual(copiedMetadata,before.filter(row=>row.key!=='worker'));assert.notEqual(ctx.store.db.prepare("SELECT value FROM metadata WHERE key='worker'").get().value,worker.value);const restored=ctx.store.get('resume',original.id);assert.equal(createHash('sha256').update(await readFile(restored.originalPath)).digest('hex'),original.hash);assert.deepEqual(await readFile(restored.originalPath),originalBytes);assert.deepEqual(await readFile(restored.previewPath),previewBytes);assert.equal(ctx.store.get('campaign','main').enabled,false);assert.equal(ctx.store.list('run').length,0);
});
