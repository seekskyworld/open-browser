// The service owns its local socket exclusively before opening this journal.
import {EventEmitter} from 'node:events';
import { operationDiagnostic } from './diagnostics.mjs';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const retentionMs = 7 * 24 * 3600_000;

export function durableReceipt(receipt) {
  const {operationId, pageId, state, phase, totalSteps, stepKind, completedSteps, error, keptPageIds, closedPageIds, fillOutcome} = receipt;
  return { operationId, ...(pageId && {pageId}), state, ...(phase && {phase}), ...(totalSteps !== undefined && {totalSteps}),
    ...(stepKind && {stepKind}), completedSteps, ...(error && {error}),
    ...(fillOutcome && {fillOutcome}),
    ...(receipt.navigation && {navigation:receipt.navigation}),
    ...(keptPageIds && {keptPageIds: [...keptPageIds]}), ...(closedPageIds && {closedPageIds: [...closedPageIds]}) };
}

export class ReceiptStore {
  constructor(path = ':memory:', actor = () => undefined) {
    this.actor = actor;
    this.notifications = new EventEmitter();
    this.waiting = 0;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS receipts (
        owner TEXT, workspace TEXT, operation TEXT, digest TEXT NOT NULL, data TEXT NOT NULL,
        inflight INTEGER NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(owner,workspace,operation));
      CREATE TABLE IF NOT EXISTS recovery_objects (
        owner TEXT NOT NULL, workspace TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL, expires INTEGER NOT NULL,
        PRIMARY KEY(owner,workspace,kind,id));
      CREATE INDEX IF NOT EXISTS recovery_expiry ON recovery_objects(expires);
      CREATE INDEX IF NOT EXISTS receipt_expiry ON receipts(expires);
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, workspace TEXT, kind TEXT, state TEXT,
        operationId TEXT, completedSteps INTEGER, expires INTEGER, actorId TEXT, pixelWidth INTEGER, pixelHeight INTEGER);
      CREATE INDEX IF NOT EXISTS event_feed ON events(owner,workspace,sequence);
      CREATE INDEX IF NOT EXISTS event_expiry ON events(expires);`);
    this.sweep = this.db.prepare('DELETE FROM receipts WHERE expires <= ?');
    this.sweepRecovery = this.db.prepare('DELETE FROM recovery_objects WHERE expires<=?');
    this.sweepRecovery.run(Date.now());
    this.sweep.run(Date.now());
    this.sweepEvents = this.db.prepare('DELETE FROM events WHERE expires<=?');
    this.sweepEvents.run(Date.now());
    const columns = new Set(this.db.prepare('PRAGMA table_info(events)').all().map(field=>field.name));
    for(const [name,type] of [['actorId','TEXT'],['pixelWidth','INTEGER'],['pixelHeight','INTEGER'],['pageId','TEXT'],['resourceId','TEXT']])
      if(!columns.has(name)) this.db.exec(`ALTER TABLE events ADD COLUMN ${name} ${type}`);
    this.appendEvent = this.db.prepare('INSERT INTO events(owner,workspace,kind,state,operationId,completedSteps,expires,actorId,pixelWidth,pixelHeight,pageId,resourceId) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    this.nextSweep = Date.now() + 60_000;
    this.read = this.db.prepare('SELECT digest,data FROM receipts WHERE owner=? AND workspace=? AND operation=? AND expires>?');
    this.write = this.db.prepare(`INSERT INTO receipts VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(owner,workspace,operation) DO UPDATE SET data=excluded.data,inflight=excluded.inflight,expires=excluded.expires
      WHERE receipts.digest=excluded.digest`);
    for (const row of this.db.prepare('SELECT * FROM receipts WHERE json_extract(data,\'$.state\') IN (\'queued\',\'running\')').all()) {
      const receipt = JSON.parse(row.data);
      receipt.state = row.inflight ? 'outcome_unknown' : 'cancelled';
      receipt.phase = receipt.state;
      receipt.error = row.inflight ? 'inspect_before_retry' : 'service_restarted';
      this.save(row.owner, row.workspace, row.digest, receipt);
    }
  }

  remember(owner, workspace, kind, id) {
    this.db.prepare('INSERT OR REPLACE INTO recovery_objects VALUES (?,?,?,?,?)')
      .run(owner, workspace, kind, id, Date.now() + retentionMs);
  }

  recoveryObjects(owner, workspace, after = 0, limit = 50) {
    if (!Number.isSafeInteger(after) || after < 0) throw Object.assign(new Error('invalid_params'), {code:'invalid_params'});
    // ReceiptStore.list has already validated the common limit.
    const rows = this.db.prepare('SELECT rowid,kind,id FROM recovery_objects WHERE owner=? AND workspace=? AND expires>? AND rowid>? ORDER BY rowid LIMIT ?')
      .all(owner, workspace, Date.now(), after, limit + 1);
    return {records:rows.slice(0,limit), nextObjectCursor:rows.length > limit ? rows[limit-1].rowid : null};
  }

  get(owner, workspace, id) {
    if (typeof workspace !== 'string' || typeof id !== 'string') return null;
    const row = this.read.get(owner, workspace, id, Date.now());
    return row ? { digest: row.digest, receipt: JSON.parse(row.data) } : null;
  }

  list(owner, workspace, after = 0, limit = 50) {
    if (typeof workspace !== 'string' || !Number.isSafeInteger(after) || after < 0 ||
        !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Object.assign(new Error('invalid_params'), {code:'invalid_params'});
    const rows = this.db.prepare('SELECT rowid,data FROM receipts WHERE owner=? AND workspace=? AND rowid>? AND expires>? ORDER BY rowid LIMIT ?')
      .all(owner, workspace, after, Date.now(), limit + 1);
    return { operations: rows.slice(0, limit).map(row => JSON.parse(row.data)),
      nextCursor: rows.length > limit ? rows[limit - 1].rowid : null };
  }

  save(owner, workspace, digest, receipt, inflight = false) {
    const now = Date.now();
    if (now >= this.nextSweep) {
      this.sweepRecovery.run(now);
      this.sweep.run(now);
      this.sweepEvents.run(now);
      this.nextSweep = now + 60_000;
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.write.run(owner, workspace, receipt.operationId, digest,
        JSON.stringify(durableReceipt(receipt)), Number(inflight), now + retentionMs);
      if (!result.changes) throw Object.assign(new Error('operation_id_conflict'), {code:'operation_id_conflict'});
      this.event(owner, workspace, inflight ? 'dispatch' : 'operation', receipt.state, receipt.operationId, receipt.completedSteps);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  event(owner, workspace, kind, state, operation = null, steps = null, size = {}) {
    this.appendEvent.run(owner, workspace, kind, state, operation, steps, Date.now() + retentionMs, this.actor() || owner,
      size.pixelWidth ?? null, size.pixelHeight ?? null, size.pageId ?? null,size.resourceId ?? null);
    if (size.resourceId) this.notifications.emit(workspace);

  }

  events(owner, workspace, after = 0, limit = 50) {
    if (typeof workspace !== 'string' || !Number.isSafeInteger(after) || after < 0 ||
        !Number.isInteger(limit) || limit < 1 || limit > 100)
      throw Object.assign(new Error('invalid_params'), {code:'invalid_params'});
    const rows = this.db.prepare('SELECT sequence,kind,state,operationId,completedSteps,actorId,pixelWidth,pixelHeight,pageId,resourceId FROM events WHERE owner=? AND workspace=? AND sequence>? AND expires>? ORDER BY sequence LIMIT ?')
      .all(owner, workspace, after, Date.now(), limit);
    return { events: rows.map(row => Object.fromEntries(Object.entries(row).filter(([,value]) => value !== null))),
      nextCursor: rows.at(-1)?.sequence ?? after };
  }

  cursor(owner,workspace) {
    return {nextCursor:this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS cursor FROM events WHERE owner=? AND workspace=?')
      .get(owner,workspace).cursor};
  }

  waitForEvent(owner,{workspaceId,pageId,operationId,kind,after,timeoutMs=5000}) {
    if (!Number.isSafeInteger(after) || after<0 || !Number.isSafeInteger(timeoutMs) || timeoutMs<1 || timeoutMs>10000 ||
        !['dialog','popup','download'].includes(kind) || typeof pageId!=='string' ||
        (operationId!==undefined && typeof operationId!=='string'))
      throw Object.assign(new Error('invalid_params'),{code:'invalid_params'});
    const sql=`SELECT sequence,kind,state,pageId,resourceId,operationId FROM events
      WHERE owner=? AND workspace=? AND pageId=? AND kind=? AND sequence>? AND expires>?
      AND (? IS NULL OR operationId=?) ORDER BY sequence LIMIT 1`;
    const query=this.db.prepare(sql);
    const read=()=>{
      const row=query.get(owner,workspaceId,pageId,kind,after,Date.now(),operationId??null,operationId??null);
      if (row?.operationId===null) delete row.operationId;
      return row && {event:row,nextCursor:row.sequence};
    };
    const first=read();
    if (first) return first;
    if (this.waiting>=128 || this.notifications.listenerCount(workspaceId)>=8)
      throw Object.assign(new Error('queue_full'),{code:'queue_full'});
    return new Promise(resolve=>{
      const done=result=>{
        clearTimeout(timer);
        this.notifications.off(workspaceId,changed);
        this.waiting--;
        resolve(result || {event:null,nextCursor:after});
      };
      const changed=()=>{
        if (this.closing) return done();
        const event=read();
        if (event) done(event);
      };
      this.waiting++;
      const timer=setTimeout(done,timeoutMs);
      this.notifications.on(workspaceId,changed);
    });
  }

  diagnose(owner, workspace, operationId) {
    const record = this.get(owner, workspace, operationId);
    if (!record) throw Object.assign(new Error('operation_not_found'), {code:'operation_not_found'});
    const dispatched = this.db.prepare("SELECT 1 FROM events WHERE owner=? AND workspace=? AND operationId=? AND kind='dispatch' AND expires>? LIMIT 1")
      .get(owner, workspace, operationId, Date.now());
    return operationDiagnostic(record.receipt, Boolean(dispatched));
  }

  clear(workspace) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM recovery_objects WHERE workspace=?').run(workspace);
      this.db.prepare('DELETE FROM receipts WHERE workspace=?').run(workspace);
      this.db.prepare('DELETE FROM events WHERE workspace=?').run(workspace);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  close() {
    this.closing=true;
    for (const workspace of this.notifications.eventNames()) this.notifications.emit(workspace);
    this.db.close();
  }
}
