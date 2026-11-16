import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const fail = (message, status=409) => Object.assign(new Error(message), {status});

export class Store {
  constructor(directory) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    this.db = new DatabaseSync(join(directory, 'hub.sqlite'));
    chmodSync(join(directory, 'hub.sqlite'), 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,identity TEXT,body TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE UNIQUE INDEX IF NOT EXISTS identity_unique ON documents(kind,identity) WHERE identity IS NOT NULL;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('schema','1');
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('state_revision','0');
    if (!this.get('profile','main')) this.put('profile',{id:'main',fullName:'',email:'',phone:'',location:'',answers:{},links:{}});
    if (!this.get('campaign','main')) this.put('campaign',{id:'main',enabled:false,status:'draft',mode:'live',revision:0,rules:{maxApplications:10,maxPerEmployer:3,maxReasoningCalls:20,allowedHosts:[],allowAccountCreation:false}});
    if (!this.get('automation','internships')) this.put('automation',{id:'internships',name:'Internship applications',purpose:'Prepare and complete selected internship applications',version:1,executor:'local',scheduleOwner:'manual',state:'draft'});
  }
  get(kind,id) { const row=this.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind,id); return row?JSON.parse(row.body):null; }
  list(kind) { return this.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY rowid').all(kind).map(row=>JSON.parse(row.body)); }
  put(kind,document) {
    if (!document?.id || typeof document.id!=='string') throw fail('Document requires a string id',400);
    const previous=this.get(kind,document.id);
    if (kind==='job' && previous?.identity && document.identity!==previous.identity) throw fail('Application identity cannot be changed');
    if (kind==='event' && previous) throw fail('Recorded events are immutable');
    const saved={...document,createdAt:previous?.createdAt||document.createdAt||now(),updatedAt:now()};
    try { this.db.prepare('INSERT INTO documents(kind,id,identity,body) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET identity=excluded.identity,body=excluded.body').run(kind,saved.id,(kind==='job'||kind==='account')?saved.identity||null:null,JSON.stringify(saved)); }
    catch(error) { if(String(error.message).includes('UNIQUE')) throw fail('This application or account is already recorded'); throw error; }
    this.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='state_revision'").run();
    return saved;
  }
  revision(){return Number(this.db.prepare("SELECT value FROM metadata WHERE key='state_revision'").get()?.value||0);}
  remove(kind,id) { if(kind==='event'||kind==='job') throw fail('Application history cannot be deleted through the queue'); const result=this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind,id);if(result.changes)this.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='state_revision'").run(); }
  transaction(fn) {
    if(this.transactionDepth) return fn();
    this.db.exec('BEGIN IMMEDIATE'); this.transactionDepth=1;
    try { const result=fn(); if(result?.then) throw fail('Transactions must be synchronous',500); this.db.exec('COMMIT'); return result; }
    catch(error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.transactionDepth=0; }
  }
  event(applicationId,type,payload={}) { return this.put('event',{id:randomUUID(),applicationId,type,payload,at:now()}); }
  acquireWorker(ownerId) {
    this.transaction(()=>{
      const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get('worker');
      if(row) {const owner=JSON.parse(row.value);let alive=false;try{process.kill(owner.pid,0);alive=true}catch{}if(alive)throw fail('Another hub worker owns this data directory. Stop that process before starting another.');}
      this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('worker',JSON.stringify({ownerId,pid:process.pid,at:now()}));
    });
  }
  releaseWorker(ownerId) {const row=this.db.prepare('SELECT value FROM metadata WHERE key=?').get('worker');if(row&&JSON.parse(row.value).ownerId===ownerId)this.db.prepare('DELETE FROM metadata WHERE key=?').run('worker');}
  async backup(path) { await backup(this.db,path); chmodSync(path,0o600); return path; }
  close() { this.db.close(); }
}
