import { checkAgentRequest } from './contract-validation.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { readCapabilities } from './capability-matrix.mjs';
import { workspaceView } from './workspace-state.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const readMethods = new Set(readCapabilities);
function fail(code) { throw Object.assign(new Error(code), { code }); }

function validateRequest(method, params) {
  // Let the engine classify an empty action batch as invalid_actions. All
  // non-empty requests continue through the strict JSON schema.
  if (method === 'act' && Array.isArray(params?.actions) && !params.actions.length) return params;
  return checkAgentRequest(method, params);
}

export class AccessRegistry {
  constructor(file) {
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS clients(id TEXT PRIMARY KEY,label TEXT NOT NULL,hash TEXT UNIQUE NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(
        id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
        agentName TEXT NOT NULL DEFAULT '', createdAt INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS grants(client TEXT REFERENCES clients(id) ON DELETE CASCADE,
        task TEXT REFERENCES tasks(id) ON DELETE CASCADE,permission TEXT NOT NULL,PRIMARY KEY(client,task));`);
    const taskColumns = new Set(this.db.prepare('PRAGMA table_info(tasks)').all().map(field => field.name));
    for (const [name, type, definition] of [
      ['name', 'TEXT', "TEXT NOT NULL DEFAULT ''"],
      ['agentName', 'TEXT', "TEXT NOT NULL DEFAULT ''"],
      ['createdAt', 'INTEGER', 'INTEGER NOT NULL DEFAULT 0'],
      ['updatedAt', 'INTEGER', 'INTEGER NOT NULL DEFAULT 0'],
    ]) {
      if (!taskColumns.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
    }
  }
  principal(token) {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    return this.db.prepare('SELECT id FROM clients WHERE hash=?').get(digest(token))?.id;
  }
  owner(task) {
    return typeof task === 'string' && this.db.prepare('SELECT owner FROM tasks WHERE id=?').get(task)?.owner;
  }
  hasDelegates(task) {
    return !!this.db.prepare('SELECT 1 FROM grants WHERE task=? LIMIT 1').get(task);
  }
  permission(client, task) {
    if (client === this.owner(task)) return 'owner';
    return typeof task === 'string' && this.db.prepare('SELECT permission FROM grants WHERE client=? AND task=?').get(client,task)?.permission;
  }
  async call(engine, client, method, params) {
    if (['capabilities','listWorkspaces','createWorkspace'].includes(method)) params = validateRequest(method,params);
    if (method === 'capabilities') return engine.call(method,{},client);
    if (method === 'createWorkspace') {
      const info = await engine.call(method, params, client);
      if (client !== 'local' && !this.db.prepare('SELECT id FROM clients WHERE id=?').get(client)) {
        await engine.call('closeWorkspace', {workspaceId:info.workspaceId}, client);
        fail('forbidden');
      }
      const now = Date.now();
      this.db.prepare('INSERT INTO tasks(id,owner,name,agentName,createdAt,updatedAt) VALUES(?,?,?,?,?,?)')
        .run(info.workspaceId, client, info.name || '', info.agentName || '', now, now);
      return info;
    }
    if (method === 'listWorkspaces') {
      const list = await engine.call(method, {}, client);
      const owned = new Set(list.map(workspace => workspace.workspaceId));
      for (const {task} of this.db.prepare('SELECT task FROM grants WHERE client=?').all(client)) {
        const ws = engine.workspaces.get(task);
        if (ws && !owned.has(task)) list.push(workspaceView(ws));
      }
      return list;
    }
    const task = params.workspaceId;
    const permission = this.permission(client,task);
    if (!permission) {
      // Trusted desktop demos may predate a registry entry.
      if (client === 'local' && !this.owner(task)) return engine.call(method,validateRequest(method,params),client);
      fail('workspace_not_found');
    }
    if (method === 'adoptCurrentTab' && (permission !== 'owner' || this.hasDelegates(task))) fail('forbidden');
    if (permission === 'read' && !readMethods.has(method)) fail('forbidden');
    const scopedMethod = permission === 'read' && method === 'observe' ? 'observeReadOnly' : method;
    const result = await engine.call(scopedMethod,validateRequest(method,params),this.owner(task),client);
    if (!this.permission(client,task) || (client !== 'local' &&
        !this.db.prepare('SELECT id FROM clients WHERE id=?').get(client))) fail('forbidden');
    return result;
  }
  /** Return local cockpit history without exposing another client's workspaces. */
  async listHistory(engine, client, {limit = 24} = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_params');
    const rows = this.db.prepare(
      'SELECT id AS workspaceId,name,agentName,createdAt,updatedAt FROM tasks WHERE owner=? ORDER BY COALESCE(updatedAt,createdAt) DESC LIMIT ?'
    ).all(client, Math.min(100, limit * 2));
    const history = rows.filter(row => !engine.workspaces.has(row.workspaceId));
    return history.slice(0, limit).map(row => {
      const operations = engine.store.list(client, row.workspaceId, 0, 8).operations;
      const latest = operations.at(-1) || null;
      return {
        ...row,
        state: latest?.state === 'failed' ? 'failed' : 'completed',
        mode: 'closed',
        operationCount: operations.length,
        recentOperation: latest,
      };
    });
  }
  async admin(engine, method, {name, principalId, workspaceId, permission, origin, allow}) {
    if (method === 'setPixelPermission') {
      const owner=this.owner(workspaceId);
      if(!owner || !this.permission(principalId,workspaceId)) fail('forbidden');
      return engine.call(method,{workspaceId,principalId,origin,allow},owner,'desktop');
    }
    if (method === 'scheduler') return engine.slots.snapshot(engine.pending);
    if (method === 'clearHistory') {
      if (!this.owner(workspaceId) || engine.workspaces.has(workspaceId)) fail('invalid_workspace');
      engine.store.clear(workspaceId);
      this.db.prepare('DELETE FROM tasks WHERE id=?').run(workspaceId);
      return {cleared:true};
    }
    if (method === 'pair') {
      if (typeof name !== 'string' || !name.trim() || name.length > 80) fail('invalid_params');
      const token = randomBytes(32).toString('hex'), id = randomUUID();
      this.db.prepare('INSERT INTO clients VALUES(?,?,?)').run(id,name.trim(),digest(token));
      return {principalId:id, token};
    }
    if (method === 'list') return this.db.prepare('SELECT id AS principalId,label AS name FROM clients ORDER BY label').all();
    if (typeof principalId !== 'string' || !this.db.prepare('SELECT id FROM clients WHERE id=?').get(principalId)) fail('client_not_found');
    let fenced = [];
    if (method === 'revokeClient') {
      fenced = this.db.prepare("SELECT task FROM grants WHERE client=? AND permission='control' UNION SELECT id FROM tasks WHERE owner=?").all(principalId,principalId);
      this.db.prepare('DELETE FROM clients WHERE id=?').run(principalId);
      for (const ws of engine.workspaces.values()) engine.visual.revokeActor(ws,principalId);
    } else {
      const owner = this.owner(workspaceId);
      if (!owner || owner === principalId) fail('invalid_workspace');
      if (method === 'grant' && engine.workspaces.get(workspaceId)?.singleTab) fail('single_tab_scope');
      const prev = this.permission(principalId,workspaceId);
      if (method === 'grant' && ['read','control'].includes(permission))
        this.db.prepare('INSERT OR REPLACE INTO grants VALUES(?,?,?)').run(principalId,workspaceId,permission);
      else if (method === 'revoke') this.db.prepare('DELETE FROM grants WHERE task=? AND client=?').run(workspaceId,principalId);
      else fail('invalid_params');
      if (method === 'revoke' && engine.workspaces.has(workspaceId)) engine.visual.revokeActor(engine.workspaces.get(workspaceId),principalId);
      if (prev === 'control' && (method === 'revoke' || permission !== 'control')) fenced = [{task:workspaceId}];
    }
    await Promise.all(fenced.map(({task}) => {
      const ws = engine.workspaces.get(task);
      if (ws?.mode === 'agent' && !ws.finishing) return engine.handOff(ws,undefined,false);
    }));
    return {updated:true};
  }
}
