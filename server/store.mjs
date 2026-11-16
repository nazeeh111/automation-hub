import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const now = () => new Date().toISOString();
const fail = (message, status=409) => Object.assign(new Error(message), {status});
// Match the inspector's historical applicationId || jobId binding without
// rewriting immutable event documents. Only string IDs can name a job.
const eventApplication="coalesce(nullif(json_extract(body,'$.applicationId'),''),json_extract(body,'$.jobId'))";
const validEventApplication="((json_type(body,'$.applicationId')='text' AND json_extract(body,'$.applicationId')<>'') OR ((json_type(body,'$.applicationId') IS NULL OR json_type(body,'$.applicationId')='null' OR (json_type(body,'$.applicationId')='text' AND json_extract(body,'$.applicationId')='')) AND json_type(body,'$.jobId')='text'))";

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
      CREATE INDEX IF NOT EXISTS events_by_application_v2 ON documents(${eventApplication}) WHERE kind='event';
      CREATE INDEX IF NOT EXISTS events_by_sequence ON documents(kind) WHERE kind='event';
      CREATE INDEX IF NOT EXISTS posting_observations_by_job ON documents(json_extract(body,'$.jobId'),json_extract(body,'$.jobIdentity')) WHERE kind='postingObservation';
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('schema','1');
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('state_revision','0');
    if (!this.get('profile','main')) this.put('profile',{id:'main',fullName:'',email:'',phone:'',location:'',answers:{},links:{}});
    if (!this.get('campaign','main')) this.put('campaign',{id:'main',enabled:false,status:'draft',mode:'live',revision:0,rules:{maxApplications:10,maxPerEmployer:3,maxReasoningCalls:20,allowedHosts:[],allowAccountCreation:false}});
    if (!this.get('automation','internships')) this.put('automation',{id:'internships',name:'Internship applications',purpose:'Prepare and complete selected internship applications',version:1,executor:'local',scheduleOwner:'manual',state:'draft'});
  }
  get(kind,id) { const row=this.db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind,id); return row?JSON.parse(row.body):null; }
  list(kind) { return this.db.prepare('SELECT body FROM documents WHERE kind=? ORDER BY rowid').all(kind).map(row=>JSON.parse(row.body)); }
  latestEvents(limit=150) {
    if(!Number.isInteger(limit)||limit<1||limit>150)throw fail('Use an activity page size from 1 to 150.',400);
    return this.db.prepare("SELECT body FROM documents WHERE kind='event' ORDER BY rowid DESC LIMIT ?").all(limit).map(row=>JSON.parse(row.body));
  }
  applicationEvents(jobId,{limit=30,before=null}={}) {
    if(typeof jobId!=='string'||!jobId||jobId.length>2000)throw fail('Application not found.',404);
    const job=this.get('job',jobId);if(!job)throw fail('Application not found.',404);
    if(!Number.isInteger(limit)||limit<1||limit>100)throw fail('Use a history page size from 1 to 100.',400);
    // Scope tokens to this persisted store and exact immutable application.
    // The cursor is a paging anchor, never an authorization credential.
    const scope=createHash('sha256').update(JSON.stringify([this.directory,job.id,job.identity||null])).digest('hex');
    let sequence=null;
    if(before!==null){
      const invalid=()=>fail('This history page is invalid or belongs to a different application or workspace. Refresh its history.',400);
      let cursor;
      try{
        if(typeof before!=='string'||before.length>4096||!before||!/^[A-Za-z0-9_-]+$/.test(before))throw invalid();
        const bytes=Buffer.from(before,'base64url');if(bytes.toString('base64url')!==before)throw invalid();
        cursor=JSON.parse(bytes.toString('utf8'));
      }catch{throw invalid();}
      if(!cursor||typeof cursor!=='object'||Array.isArray(cursor)||Object.keys(cursor).sort().join(',')!=='eventId,scope,sequence,version'||cursor.version!==1||cursor.scope!==scope||!Number.isSafeInteger(cursor.sequence)||cursor.sequence<1||typeof cursor.eventId!=='string'||!cursor.eventId||cursor.eventId.length>2000)throw invalid();
      const anchor=this.db.prepare(`SELECT rowid AS sequence FROM documents WHERE kind='event' AND id=? AND ${eventApplication}=? AND ${validEventApplication}`).get(cursor.eventId,jobId);
      if(!anchor||anchor.sequence!==cursor.sequence)throw invalid();
      sequence=cursor.sequence;
    }
    // The partial application index also carries rowid. Read only this role's
    // next bounded range, with one lookahead row for an honest hasMore result.
    const rows=sequence===null?
      this.db.prepare(`SELECT rowid AS sequence,id,body FROM documents WHERE kind='event' AND ${eventApplication}=? AND ${validEventApplication} ORDER BY rowid DESC LIMIT ?`).all(jobId,limit+1):
      this.db.prepare(`SELECT rowid AS sequence,id,body FROM documents WHERE kind='event' AND ${eventApplication}=? AND ${validEventApplication} AND rowid<? ORDER BY rowid DESC LIMIT ?`).all(jobId,sequence,limit+1);
    const hasMore=rows.length>limit,page=rows.slice(0,limit),last=page.at(-1);
    const nextCursor=hasMore?Buffer.from(JSON.stringify({version:1,scope,sequence:last.sequence,eventId:last.id})).toString('base64url'):null;
    return {events:page.map(row=>JSON.parse(row.body)),hasMore,nextCursor};
  }
  put(kind,document) {
    if (!document?.id || typeof document.id!=='string') throw fail('Document requires a string id',400);
    const previous=this.get(kind,document.id);
    if (kind==='job' && previous?.identity && document.identity!==previous.identity) throw fail('Application identity cannot be changed');
    if (kind==='event' && previous) throw fail('Recorded events are immutable');
    if (kind==='postingObservation' && previous) throw fail('Recorded employer posting versions are immutable');
    const saved={...document,createdAt:previous?.createdAt||document.createdAt||now(),updatedAt:now()};
    try { this.db.prepare('INSERT INTO documents(kind,id,identity,body) VALUES(?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET identity=excluded.identity,body=excluded.body').run(kind,saved.id,(kind==='job'||kind==='account')?saved.identity||null:null,JSON.stringify(saved)); }
    catch(error) { if(String(error.message).includes('UNIQUE')) throw fail('This application or account is already recorded'); throw error; }
    this.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='state_revision'").run();
    return saved;
  }
  revision(){return Number(this.db.prepare("SELECT value FROM metadata WHERE key='state_revision'").get()?.value||0);}
  remove(kind,id) { if(kind==='event'||kind==='job'||kind==='postingObservation') throw fail('Application history cannot be deleted through the queue'); const result=this.db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind,id);if(result.changes)this.db.prepare("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE key='state_revision'").run(); }
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
