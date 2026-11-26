import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { OpenBrowserClient } from '../sdk.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('hex');
const active = new Set(['queued','running']);
const terminal = new Set(['completed','failed','cancelled','outcome_unknown']);
const strings = /^[a-zA-Z0-9_-]{1,80}$/;
const rejectedBeforeDispatch = new Set(['invalid_params', 'invalid_url', 'invalid_actions', 'stale_control', 'stale_document',
  'origin_denied', 'page_not_found', 'queue_full', 'operation_limit', 'workspace_under_user_control']);
const sessionKey = (tenant, sessionId) => hash(JSON.stringify([tenant, sessionId]));
const writeMethods = new Set(['openPage','act','finishWorkspace','closeWorkspace']);
function fail(code) { throw Object.assign(new Error(code), {code}); }

export class Directory {
  constructor(home, config, digestKey) {
    this.digestKey = digestKey;
    this.db = new DatabaseSync(path.join(home,'directory.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, public_id TEXT NOT NULL, tenant TEXT, node TEXT, incarnation TEXT,
        workspace TEXT, create_digest TEXT, state TEXT NOT NULL, lease TEXT, expires INTEGER DEFAULT 0, pending TEXT, decision TEXT);
      CREATE TABLE IF NOT EXISTS ops (session TEXT, id TEXT, method TEXT, digest TEXT, status TEXT, page TEXT,
        PRIMARY KEY(session,id));`);
    this.nodes = new Map();
    for (const {id, socketPath, tokenPath, tenants} of config.nodes) {
      if (!strings.test(id) || this.nodes.has(id) || !Array.isArray(tenants) || !tenants.length ||
          tenants.some(t=>!strings.test(t)) || !path.isAbsolute(socketPath) || !path.isAbsolute(tokenPath))
        fail('invalid_node_config');
      this.nodes.set(id,{id, socketPath, tokenPath, tenants:new Set(tenants), api:new OpenBrowserClient({socketPath,tokenPath}), healthy:false});
    }
    this.db.exec("UPDATE sessions SET lease=NULL, expires=0; UPDATE sessions SET state='review' WHERE state='creating' OR (state='live' AND pending IS NOT NULL)");
    this.stopped = false;
    this.inFlight = new Set();
    this.timer = setInterval(()=>{ void this.probeAll(); },750).unref();
  }
  one(sql,...args) { return this.db.prepare(sql).get(...args); }
  change(sql,...args) { return this.db.prepare(sql).run(...args); }
  async probe(node) {
    if (node.probing || this.stopped) return;
    node.probing = true;
    let identity;
    try {
      const token = (await readFile(node.tokenPath, 'utf8')).trim();
      if (!/^[0-9a-f]{64}$/.test(token)) fail('invalid_node_token');
      await new Promise((resolve, reject) => {
        const req = request({ socketPath: node.socketPath, method: 'POST', path: '/v1/call',
          signal: AbortSignal.timeout(2000), headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }
        }, res => {
          res.on('error', reject);
          res.on('end', () => res.statusCode === 200 ? resolve() : reject(new Error('health_check_failed')));
          res.resume();
        });
        req.once('error', reject);
        req.end(JSON.stringify({ method: 'capabilities', params: {} }));
      });
      identity = hash(token);
    } catch { identity = null; }
    finally { node.probing = false; }
    if (this.stopped) return;
    node.healthy = !!identity;
    node.sampled = Date.now();
    node.incarnation = identity;
    this.change("UPDATE sessions SET state='review',lease=NULL,expires=0 WHERE node=? AND state IN ('live','creating') AND (incarnation!=? OR ? IS NULL)",
      node.id, identity, identity);
  }
  probeAll() { return Promise.all([...this.nodes.values()].map(node => this.probe(node))); }
  digest(value) { return createHmac('sha256', this.digestKey).update(JSON.stringify(value)).digest('hex'); }
  healthy(node) { return node?.healthy && Date.now()-node.sampled < 5000; }
  row(tenant,id) {
    const row = this.one('SELECT * FROM sessions WHERE id=? AND tenant=?',id,tenant);
    if (!row) fail('session_not_found');
    return row;
  }
  view(row) {
    return {sessionId:row.public_id,node:row.node,state:row.state,pendingOperationId:row.pending,
      leaseExpiresAt:row.expires || null,decision:row.decision};
  }
  lock(row,token) {
    if (row.state!=='live') fail(row.state==='review'?'review_required':'session_inactive');
    if (typeof token!=='string' || row.lease!==hash(token) || row.expires<=Date.now()) fail('invalid_lease');
  }
  async create(tenant,{sessionId,allowedOrigins,resourceOrigins,name,agentName}) {
    if (typeof sessionId!=='string' || !strings.test(sessionId)) fail('invalid_session_id');
    if (typeof name !== 'string' || !name.trim()) fail('task_name_required');
    const id = sessionKey(tenant, sessionId);
    const existing=this.one('SELECT * FROM sessions WHERE id=?',id);
    const digest = this.digest([allowedOrigins, resourceOrigins, name, agentName]);
    if (existing) {
      const own = this.row(tenant, id);
      if (own.create_digest !== digest) fail('session_id_conflict');
      return this.view(own);
    }
    const load = this.db.prepare("SELECT node,count(*) AS count FROM sessions WHERE state IN ('creating','live','review') GROUP BY node").all();
    const counts = new Map(load.map(entry => [entry.node, entry.count]));
    const candidates = [...this.nodes.values()].filter(node => this.healthy(node) && node.tenants.has(tenant));
    candidates.sort((a, b) => (counts.get(a.id) || 0) - (counts.get(b.id) || 0) || a.id.localeCompare(b.id));
    const node = candidates[0];
    if (!node) fail('node_unavailable');
    this.change("INSERT INTO sessions(id,public_id,tenant,node,incarnation,create_digest,state) VALUES(?,?,?,?,?,?,'creating')",id,sessionId,tenant,node.id,node.incarnation,digest);
    this.inFlight.add(id);
    try {
      const ws=await node.api.createWorkspace({allowedOrigins,resourceOrigins,name,agentName});
      this.change("UPDATE sessions SET workspace=?,state=CASE WHEN state='creating' THEN 'live' ELSE state END WHERE id=?",ws.workspaceId,id);
    } catch (error) {
      if (['invalid_params', 'invalid_url', 'workspace_limit', 'task_name_required'].includes(error.code)) {
        this.change("DELETE FROM sessions WHERE id=? AND state='creating'", id);
        throw error;
      }
      this.change("UPDATE sessions SET state='review' WHERE id=?", id);
    } finally { this.inFlight.delete(id); }
    return this.view(this.row(tenant,id));
  }
  async request(tenant,method,args) {
    if(!args || typeof args!=='object' || Array.isArray(args)) fail('invalid_params');
    if(method==='nodes') return [...this.nodes.values()].filter(n=>n.tenants.has(tenant)).map(n=>({id:n.id,healthy:!!this.healthy(n)}));
    if(method==='sessions') return this.db.prepare('SELECT * FROM sessions WHERE tenant=? ORDER BY public_id').all(tenant).map(r=>this.view(r));
    if(method==='create') return this.create(tenant,args);
    if(typeof args.sessionId!=='string') fail('invalid_session_id');
    const row=this.row(tenant,sessionKey(tenant,args.sessionId)), node=this.nodes.get(row.node);
    if(method==='status') return this.view(row);
    if(method==='receipt') return this.receipt(row,args.operationId);
    if (row.state === 'review') fail('review_required');
    if (!node?.tenants.has(tenant)) fail('node_unavailable');
    if(!this.healthy(node)) fail('node_unavailable');
    if(method==='acquire') {
      if(row.state!=='live') fail('review_required');
      if(row.pending || row.lease && row.expires>Date.now()) fail('lease_busy');
      const token=opaque(), expires=Date.now()+30_000;
      this.change('UPDATE sessions SET lease=?,expires=? WHERE id=?',hash(token),expires,row.id);
      return {lease:token,expires};
    }
    this.lock(row,args.lease);
    if(method==='renew') {
      const expires=Date.now()+30_000;
      this.change('UPDATE sessions SET expires=? WHERE id=?',expires,row.id);
      return {expires};
    }
    if(method==='release') {
      if(row.pending || this.inFlight.has(row.id)) fail('operation_pending');
      this.change('UPDATE sessions SET lease=NULL,expires=0 WHERE id=?',row.id);
      return {released:true};
    }
    if(method==='observe') {
      const {cursor, name, limit, region, includeFrames, frameControls} = args;
      const result=await node.api.observe({workspaceId:row.workspace,pageId:args.pageId,
        cursor,name,limit,region,includeFrames,frameControls});
      this.lock(this.row(tenant,row.id),args.lease);
      return result;
    }
    if(!writeMethods.has(method)) fail('unknown_method');
    const {operationId,params={}}=args;
    if(typeof operationId!=='string'||!strings.test(operationId)||!params||typeof params!=='object'||Array.isArray(params)) fail('invalid_params');
    if (method === 'finishWorkspace' && (!Array.isArray(params.keepPageIds) || params.keepPageIds.length)) fail('hosted_keep_unavailable');
    const digest=this.digest([method,params]);
    const old=this.one('SELECT * FROM ops WHERE session=? AND id=?',row.id,operationId);
    if(old) {
      if(old.digest!==digest) fail('operation_id_conflict');
      return this.receipt(row,operationId);
    }
    if(row.pending || this.inFlight.has(row.id)) fail('operation_pending');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.change("INSERT INTO ops VALUES(?,?,?,?,'dispatched',NULL)",row.id,operationId,method,digest);
      this.change('UPDATE sessions SET pending=? WHERE id=?',operationId,row.id);
      this.db.exec('COMMIT');
    } catch(error) { this.db.exec('ROLLBACK');throw error; }
    this.inFlight.add(row.id);
    try {
      // Preserve the engine's stable invalid_actions error for an empty batch.
      // The hosted envelope normally validates page metadata first, so provide
      // inert identifiers only for this pre-dispatch validation case.
      const forwarded = method === 'act' && Array.isArray(params.actions) && !params.actions.length
        ? {...params, pageId: params.pageId || 'invalid', documentId: params.documentId || 'invalid',
          controlGeneration: params.controlGeneration || 'invalid'}
        : params;
      const result=await node.api.call(method,{...forwarded,workspaceId:row.workspace,
        ...(['act','finishWorkspace'].includes(method) && {operationId})});
      const current=this.row(tenant,row.id);
      if(current.state!=='live') return this.receipt(current,operationId);
      const state=result.state || 'completed';
      if(active.has(state)) {
        this.change('UPDATE ops SET status=? WHERE session=? AND id=?',state,row.id,operationId);
      } else {
        this.settle(row,operationId,method,state,result.pageId);
      }
      return this.receipt(this.row(tenant,row.id),operationId);
    } catch (error) {
      if (rejectedBeforeDispatch.has(error.code) && this.row(tenant,row.id).state === 'live') {
        this.settle(row,operationId,method,'failed');
        throw error;
      }
      this.change("UPDATE sessions SET state='review',lease=NULL,expires=0 WHERE id=?",row.id);
      return this.receipt(this.row(tenant,row.id),operationId);
    } finally { this.inFlight.delete(row.id); }
  }
  settle(row,id,method,status,page) {
    if(!terminal.has(status)) fail('invalid_receipt');
    const next=status==='outcome_unknown'?'review':
      status==='completed'&&['closeWorkspace','finishWorkspace'].includes(method)?'closed':'live';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.change('UPDATE ops SET status=?,page=? WHERE session=? AND id=?',status,page||null,row.id,id);
      this.change("UPDATE sessions SET state=?,pending=?,lease=CASE WHEN ?='live' THEN lease ELSE NULL END,expires=CASE WHEN ?='live' THEN expires ELSE 0 END WHERE id=? AND state='live' AND pending=?",
        next,next==='review'?id:null,next,next,row.id,id);
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  async receipt(row,id) {
    if(typeof id!=='string') fail('invalid_operation_id');
    const op=this.one('SELECT * FROM ops WHERE session=? AND id=?',row.id,id);
    if(!op) fail('operation_not_found');
    const node=this.nodes.get(row.node);
    if(row.state==='live' && active.has(op.status) && this.healthy(node)) {
      try {
        const value=await node.api.getOperation(row.workspace,id);
        if(terminal.has(value.state) && this.row(row.tenant,row.id).state==='live')
          this.settle(row,id,op.method,value.state);
        op.status=value.state;
      } catch {
        this.change("UPDATE sessions SET state='review',lease=NULL,expires=0 WHERE id=? AND pending=?",row.id,id);
      }
    }
    const current = this.row(row.tenant,row.id);
    const needsReview = current.pending === id && current.state === 'review';
    const verified = current.pending === id && current.state === 'archived';
    return {operationId:id, state:verified ? current.decision : needsReview ? 'review_required' : op.status,
      pageId:op.page || undefined, session:this.view(current)};
  }
  async review({tenant,sessionId,decision}) {
    if(typeof tenant!=='string'||typeof sessionId!=='string') fail('invalid_params');
    const id = sessionKey(tenant, sessionId);
    const row=this.row(tenant,id), node=this.nodes.get(row.node);
    if(row.state!=='review' || this.inFlight.has(row.id)) fail('review_unavailable');
    if(!decision) {
      let nodeReceipt;
      if(row.workspace && row.pending && this.healthy(node)) {
        try {
          const result=await node.api.getOperation(row.workspace,row.pending);
          nodeReceipt={state:result.state,completedSteps:result.completedSteps};
        } catch { /* Unavailable receipt leaves the review pending. */ }
      }
      return {session:this.view(row),workspaceId:row.workspace,nodeReceipt};
    }
    if(!['applied','not_applied','unknown'].includes(decision)) fail('invalid_decision');
    if(!this.healthy(node)) fail('verify_node_before_archiving');
    // Quiesce any surviving workspace before allowing a fresh session. A new
    // worker has lost the old context; an application-level absence is expected.
    if (!row.workspace && node.incarnation === row.incarnation) fail('restart_node_to_retire_unknown_workspace');
    if(row.workspace) {
      try { await node.api.closeWorkspace(row.workspace); }
      catch(error) { if(error.code!=='workspace_not_found') throw error; }
    }
    this.change("UPDATE sessions SET state='archived',lease=NULL,expires=0,decision=? WHERE id=? AND state='review'",decision,row.id);
    return this.view(this.row(tenant,row.id));
  }
  close() {this.stopped=true; clearInterval(this.timer); this.db.close();}
}
