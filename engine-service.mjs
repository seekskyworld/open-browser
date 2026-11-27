import { close as closeWorkspace, finish, finishDigest, handOff, returnToAgent } from './workspace-lifecycle.mjs';
import { perform } from './action-execution.mjs';
import { allowedPageOrigin, clearFrameRefs, clearRefs, fail, publicError, redact, requirePageOrigin, stringParam, webOrigin, workspaceView } from './workspace-state.mjs';
import {workflowRequest,workflowOrigin,performWorkflow} from './site-workflow.mjs';
import { agentMethods, capabilityProfiles, limits } from './api-contract.mjs';
import {UploadGrants} from './uploads.mjs';
import {attachDialogs, discardDialog, respondDialog} from './page-dialogs.mjs';
import { installPopupBridge } from './managed-popup.mjs';
import { VisualPages, visualActions, validateVisualAction } from './visual-page.mjs';
import { profileId as serviceProfileId } from './paths.mjs';
import { WorkspaceDownloads } from './downloads.mjs';
import { WorkspaceScheduler } from './scheduler.mjs';
import { inspectDocument, readDocumentSummary, frameAllowed, observeFrames } from './page-observation.mjs';
import { blockedRequests, rememberBlock, routeWorkspace } from './network-policy.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ReceiptStore } from './receipt-store.mjs';
import { DesktopFrames, enqueueHuman, navigatePage, pageInput, pageLocation, refreshTitle, releaseInput } from './desktop-page.mjs';
import { privacyCapabilities } from './privacy-config.mjs';
import { buildProfile } from './build-profile.mjs';
import path from 'node:path';
import { stateDir } from './paths.mjs';
import { OutputStore } from './output-store.mjs';
import { ActivityNotifier } from './activity-notifier.mjs';

function observationMatch(ws, match) {
  if (!match) return {};
  return {match:{...match,candidates:match.candidates.map(({role,name,within})=>({
    role,name:redact(ws,name),...(within && {within:{role:within.role,name:redact(ws,within.name)}})
  }))}};
}

// The renderer receives only the overlap length. Locate complete secrets on
// the service side, then redact their intersection with the returned slice.
function observationText(ws,text,window) {
  if(!window) return redact(ws,text);
  const {padded,skip,length}=window;
  const hidden=new Uint8Array(length);
  for(const secret of ws.credentials.values()) {
    let start=padded.indexOf(secret);
    while(start>=0) {
      const end=Math.min(length,start+secret.length-skip);
      if(end>0 && start<skip+length) hidden.fill(1,Math.max(0,start-skip),end);
      start=padded.indexOf(secret,start+1);
    }
  }
  let clean='';
  for(let i=0;i<length;i++) {
    if(!hidden[i]) clean+=text[i];
    else if(!i || !hidden[i-1]) clean+='[redacted]';
  }
  return clean;
}

const statusQueries = new Set(['getWorkspace', 'visualStatus', 'listDownloads', 'listOutputs', 'readOutput',
  'listUploads', 'getOperation', 'diagnoseOperation', 'listOperations', 'listEvents', 'eventCursor',
  'waitForEvent', 'getRecoverySummary']);

export class BrowserService {
  constructor(browser, { concurrency = 4, lowMemoryMiB = Number(process.env.OPEN_BROWSER_LOW_MEMORY_MIB || 0), idleTimeoutMs = 30 * 60_000, sharedContext, groupTab, onActivity, onActionTarget,
    journalPath, releaseTab, setInputGuard, readOnlyObserver = readDocumentSummary } = {}) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) fail('invalid_concurrency');
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) fail('invalid_idle_timeout');
    this.browser = browser;
    this.sharedContext = sharedContext;
    this.groupTab = groupTab;
    this.releaseTab = releaseTab;
    if (setInputGuard) this.setInputGuard = (ws, tab, enabled) => setInputGuard(tab, enabled, () => {
      ws.guardLost = true;
      if (ws.mode === 'agent' && !ws.finishing && !this.stopped)
        void this.handOff(ws, undefined, false).catch(() => {});
    });
    this.readOnlyObserver = readOnlyObserver;
    this.actors = new AsyncLocalStorage();
    this.store = new ReceiptStore(journalPath, () => this.actors.getStore());
    this.outputs = new OutputStore(path.join(stateDir, 'open-browser-deliveries'));
    this.onActivity = onActivity;
    this.onActionTarget = onActionTarget;
    this.frames = new DesktopFrames();
    this.visual = new VisualPages();
    this.workspaces = new Map();
    this.slots = new WorkspaceScheduler(concurrency, { lowMemoryMiB });
    this.pending = 0;
    this.creatingContext = Promise.resolve();
    this.protocol = null;
    this.stopped = false;
    this.idleTimeoutMs = idleTimeoutMs;
    this.notifier = new ActivityNotifier(onActivity, workspaceId => this.workspaces.has(workspaceId));
    this.sweep = setInterval(() => {
      const cutoff = Date.now() - idleTimeoutMs;
      for (const ws of this.workspaces.values()) {
        if (ws.mode === 'agent' && !ws.pending && !ws.finishing && ws.lastActiveAt <= cutoff &&
            !ws.credentialRequests.size && ![...ws.pages.values()].some(tab => tab.needsSubmissionReview))
          void closeWorkspace(this, ws).catch(() => {});
      }
    }, Math.min(60_000, idleTimeoutMs)).unref();
  }

  notify(ws) {
    this.notifier.notify(ws);
  }

  invalidateObservation(tab) {
    if (tab) tab.observationCache = undefined;
  }

  async observationRevision(tab) {
    try {
      return await tab.page.evaluate(() => {
        const key = '__openBrowserObservationRevision';
        if (!Number.isSafeInteger(window[key])) {
          window[key] = 1;
          const ignored = node => node?.closest?.('[data-open-browser-activity],[data-open-browser-target],[data-open-browser-agent-cursor],[data-open-browser-label]');
          const observer = new MutationObserver(records => {
            if (records.some(record => {
              if (record.type === 'attributes' && ignored(record.target)) return false;
              if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].every(ignored)) return false;
              return true;
            })) window[key]++;
          });
          observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          Object.defineProperty(window, '__openBrowserObservationObserver', { value: observer, configurable: true });
        }
        return window[key];
      });
    } catch {
      return null;
    }
  }

  notifyTarget(ws, tab, el, documentId, controlGeneration, origin, actionKind = '操作') {
    if (!this.onActionTarget) return;
    const ticket = Symbol();
    tab.latestTarget = ticket;
    // Coordinates are advisory. Capture geometry alongside the real action,
    // without scrolling the page or delaying dispatch for a desktop effect.
    const viewport = tab.page.viewportSize() ||
      tab.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    void Promise.all([el.boundingBox(), viewport]).then(([box, size]) => {
      if (!box || tab.latestTarget !== ticket || ws.pages.get(tab.id) !== tab || tab.page.isClosed() ||
          ws.mode !== 'agent' || ws.generation !== controlGeneration || tab.documentId !== documentId ||
          allowedPageOrigin(ws, tab) !== origin) return;
      const left = Math.max(0, box.x), right = Math.min(size.width, box.x + box.width);
      const top = Math.max(0, box.y), bottom = Math.min(size.height, box.y + box.height);
      if (!(right > left && bottom > top)) return;
      const target = { workspaceId: ws.id, pageId: tab.id, documentId, controlGeneration,
        x: (left + right) / 2, y: (top + bottom) / 2, origin };
      Object.defineProperty(target, 'actionKind', { value: actionKind, enumerable: false });
      this.store.event(ws.owner, ws.id, 'action', 'running', null, null,
        { pageId: tab.id, resourceId: String(actionKind).slice(0, 64) });
      return this.onActionTarget(target);
    }).catch(() => {});
  }

  call(method, params = {}, clientId, actorId = clientId) {
    return this.actors.run(actorId, () => this.execute(method, params, clientId));
  }

  async execute(method, params, clientId) {
    if (this.stopped) fail('service_stopped');
    if (typeof clientId !== 'string' || !clientId) fail('unauthorized');
    if (!params || typeof params !== 'object' || Array.isArray(params)) fail('invalid_params');
    if (method === 'capabilities') return {version:1,contractVersion:2,buildProfile,methods:agentMethods,capabilities:capabilityProfiles,limits,privacy:privacyCapabilities(),visual:{enabled:this.visual.enabled,actions:this.visual.enabled ? visualActions : []}};
    if(method==='runWorkflow') {
      params=workflowRequest(params);
      method='act';
    }
    if (method === 'createWorkspace') return this.create(params, clientId);
    if (method === 'open') return this.openWorkspace(params, clientId);
    if (method === 'listWorkspaces')
      return [...this.workspaces.values()].filter(ws => ws.owner === clientId).map(ws => workspaceView(ws));
    if (method === 'eventCursor') return this.store.cursor(clientId,params.workspaceId);
    if (method === 'waitForEvent') return this.store.waitForEvent(clientId,params);
    if (method === 'listEvents') return this.store.events(clientId, params.workspaceId, params.after, params.limit);
    if (method === 'getRecoverySummary') {
      const live = this.workspaces.get(params.workspaceId);
      const ws = live?.owner === clientId ? live : undefined;
      const {operations, nextCursor} = this.store.list(clientId, params.workspaceId, params.after, params.limit);
      const {records, nextObjectCursor} = this.store.recoveryObjects(clientId, params.workspaceId, params.objectsAfter, params.limit);
      if (!ws && !records.length && !operations.length && !this.store.events(clientId,params.workspaceId,0,1).events.length)
        fail('workspace_not_found');
      const pages = records.filter(row => row.kind === 'page').map(({id}) => ({
        pageId:id, next: ws?.pages.has(id) ? 'observe' : 'handle_unavailable'
      }));
      return {
        workspaceId:params.workspaceId, mode:ws?.mode ?? 'unavailable', pages,
        deliveries:records.filter(row => row.kind === 'download').map(row => ({downloadId:row.id})),
        outputs:records.filter(row => row.kind === 'output').map(row => ({outputId:row.id})),
        operations:operations.map(receipt => ({...receipt, next:
          receipt.state === 'outcome_unknown' ? 'verify_site' :
          ['running','queued'].includes(receipt.state) ? 'poll' :
          receipt.state === 'completed' ? 'already_completed' : 'inspect_receipt'})),
        nextCursor, nextObjectCursor
      };
    }
    if (method === 'diagnoseOperation') return this.store.diagnose(clientId, params.workspaceId, params.operationId);
    if (method === 'listOperations')
      return this.store.list(clientId, params.workspaceId, params.after, params.limit);
    const ws = this.workspaces.get(params.workspaceId);
    if (!ws || ws.owner !== clientId) {
      if (['listOutputs', 'readOutput'].includes(method)) {
        const {records} = this.store.recoveryObjects(clientId, params.workspaceId, 0, 100);
        const known = records.some(record => record.kind === 'output' &&
          (method === 'listOutputs' || record.id === params.outputId));
        if (known) {
          return method === 'listOutputs' ? this.outputs.list(params.workspaceId) :
            this.outputs.read(params.workspaceId, params.outputId, params);
        }
      }
      const past = this.store.get(clientId, params.workspaceId, params.operationId);
      if (past && method === 'getOperation') return past.receipt;
      if (past && ['act','finishWorkspace','hostFinishWorkspace'].includes(method)) {
        const digest = method === 'act' ? this.actionDigest(params) : finishDigest(params.keepPageIds);
        if (past.digest !== digest) fail('operation_id_conflict');
        return past.receipt;
      }
      fail('workspace_not_found');
    }
    if (ws.finishing && !['getOperation','getWorkspace','finishWorkspace','hostFinishWorkspace'].includes(method)) fail('workspace_finishing');
    if (!statusQueries.has(method)) ws.lastActiveAt = Date.now();
    switch (method) {
      case 'getWorkspace': return workspaceView(ws, true);
      case 'listUploads': return ws.uploads.list();
      case 'grantUpload': {
        if (this.actors.getStore() !== 'desktop') fail('forbidden');
        return ws.uploads.grant(ws,this.tab(ws,params.pageId),params);
      }
      case 'revokeUpload':
        if (this.actors.getStore() !== 'desktop') fail('forbidden');
        ws.uploads.remove(params.fileId);
        return {revoked:true};
      case 'respondDialog': {
        const result = await respondDialog(ws,this.tab(ws,params.pageId),params,this.actors.getStore()==='desktop');
        this.notify(ws);
        return result;
      }
      case 'listDownloads': return ws.downloads.list();
      case 'listOutputs': return ws.downloads.listOutputs();
      case 'readOutput': return ws.downloads.readOutput(params.outputId, params);
      case 'cancelDownload':
        if (this.actors.getStore() !== 'desktop') this.requireControl(ws, ws.generation);
        return ws.downloads.cancel(params.downloadId);
      case 'keepDownload':
        if (this.actors.getStore() !== 'desktop') fail('forbidden');
        {
          const result = await ws.downloads.keep(params.downloadId);
          this.store.remember(ws.owner, ws.id, 'download', params.downloadId);
          this.store.remember(ws.owner, ws.id, 'output', result.output.id);
          return result;
        }
      case 'visualStatus': return {lastCapture:ws.lastVisualCapture || null};
      case 'grantOrigin': {
        if (params.controlGeneration !== ws.generation || !['agent', 'human'].includes(ws.mode)) fail('stale_control');
        const origin = webOrigin(params.origin);
        if (origin !== params.origin || !['navigation', 'resource'].includes(params.scope)) fail('invalid_params');
        const key = params.scope + '\n' + origin;
        if (!ws.blockedOrigins.has(key)) fail('origin_not_requested');
        const origins = params.scope === 'resource' ? ws.resourceOrigins : ws.origins;
        if (origins.size >= 32 && !origins.has(origin)) fail('origin_limit');
        origins.add(origin);
        ws.blockedOrigins.delete(key);
        this.notify(ws);
        return { origin, scope: params.scope, granted: true };
      }
      case 'setPixelPermission': return this.visual.permission(ws,params);
      case 'captureVisual': return this.enqueue(ws, async () => {
        const frame=await this.visual.capture(ws,this.tab(ws,params.pageId),this.actors.getStore(),params,'agent');
        this.store.event(ws.owner,ws.id,'visual_capture','completed',null,null,frame);
        return frame;
      }, {kind:'captureVisual',pageId:params.pageId});
      case 'captureRemoteVisual': return this.visual.capture(ws,this.tab(ws,params.pageId),this.actors.getStore(),params,'human');
      case 'remoteVisualInput': return enqueueHuman(ws,params.controlGeneration,() =>
        this.visual.input(ws,this.tab(ws,params.pageId),this.actors.getStore(),params,'human'));
      case 'pageFrame': {
        const frame = await this.frames.capture(ws, this.tab(ws, params.pageId), params);
        frame.title = redact(ws, frame.title);
        return frame;
      }
      case 'pageInput': return pageInput(ws, this.tab(ws, params.pageId), params);
      case 'pageLocation': return pageLocation(ws, this.tab(ws, params.pageId));
      case 'pageNew': return this.desktopNavigate(ws, params, true);
      case 'pageNavigate': return this.desktopNavigate(ws, params, false);
      case 'closePage': {
        const tab = this.tab(ws, params.pageId);
        await tab.page.close();
        return { workspaceId: ws.id, pageId: tab.id, closed: true };
      }
      case 'previewPage': return this.previewPage(ws, this.tab(ws, params.pageId));
      case 'observeReadOnly': return this.enqueue(ws, () => this.observe(ws, this.tab(ws, params.pageId), params, true),
        { kind:'observe', pageId:params.pageId });
      case 'showPage':
        if (ws.mode !== 'human') fail('not_in_human_control');
        await this.tab(ws, params.pageId).page.bringToFront();
        return { workspaceId: ws.id, pageId: params.pageId };
      case 'openPage': return this.enqueue(ws, job => this.open(ws, params.url, job), { kind: 'openPage' });
      case 'observe': return this.enqueue(ws, () => this.observe(ws, this.tab(ws, params.pageId), params),
        { kind: 'observe', pageId: params.pageId });
      case 'observeAndAct': return this.observeAndAct(ws, params);
      case 'act': return this.act(ws, params);
      case 'setCredential': return this.setCredential(ws, params);
      case 'resolveCredential': {
        const request = ws.credentialRequests.get(params.pageId);
        if (!request || ws.mode !== 'agent' || ws.generation !== params.controlGeneration ||
            this.tab(ws, params.pageId).documentId !== params.documentId ||
            !['documentId','controlGeneration','operationId','origin','credentialRef'].every(k => request[k] === params[k]) ||
            !allowedPageOrigin(ws,this.tab(ws,params.pageId))) fail('stale_credential_request');
        if(request.frameId) {
          const tab=this.tab(ws,params.pageId);
          const frame=tab.page.frames().find(frame=>tab.frameDocuments.get(frame)?.frameId===request.frameId);
          if(!frame || URL.parse(frame.url())?.origin!==params.origin || !await frameAllowed(frame,ws.origins)) fail('stale_credential_request');
        } else if(allowedPageOrigin(ws,this.tab(ws,params.pageId))!==params.origin) fail('stale_credential_request');
        return this.setCredential(ws, params);
      }
      case 'finishWorkspace': return finish(this, ws, params);
      case 'hostFinishWorkspace': return finish(this, ws, params, true);
      case 'getOperation':
      case 'cancelOperation': {
        const op = ws.operations.get(params.operationId);
        if (!op) {
          const saved = this.store.get(clientId, ws.id, params.operationId);
          if (saved && method === 'getOperation') return saved.receipt;
          fail('operation_not_found');
        }
        if (method === 'cancelOperation') {
          const tab = ws.pages.get(op.pageId);
          if (ws.mode === 'agent' && tab?.dialog?.info.operationId === op.receipt.operationId) discardDialog(tab);
          op.cancel = true;
          op.controller?.abort();
          if (op.receipt.state === 'queued') op.receipt.state = 'cancelled';
          this.notify(ws);
        }
        return this.receiptView(ws, op);
      }
      case 'handOff':
      case 'takeControl': return this.handOff(ws, params.pageId, true, params.controlGeneration);
      case 'returnToAgent': return this.returnToAgent(ws, params.controlGeneration);
      case 'closeWorkspace':
        if (ws.mode !== 'agent') fail('workspace_under_user_control');
        await closeWorkspace(this, ws);
        return { workspaceId: ws.id, closed: true };
      default: fail('unknown_method');
    }
  }

  async create({ profileId, name = '', agentName = 'Agent', allowedOrigins = [], resourceOrigins = [], networkMode = 'strict' }, owner) {
    if (profileId !== undefined && profileId !== serviceProfileId) fail('profile_mismatch');
    if (typeof name !== 'string' || !name.trim()) fail('task_name_required');
    if (name.length > 120 || !Array.isArray(allowedOrigins)
        || allowedOrigins.length > 32) fail('invalid_params');
    if (typeof agentName !== 'string' || [...agentName].length > 80) fail('invalid_params');
    if (!['strict','browser'].includes(networkMode)) fail('invalid_params');
    const displayName = agentName.replace(/[\p{Cc}\p{Bidi_Control}\u2028\u2029]+/gu, ' ').trim() || 'Agent';
    const origins = new Set(allowedOrigins.map(webOrigin));
    if (!Array.isArray(resourceOrigins) || resourceOrigins.length > 32) fail('invalid_params');
    const resources = new Set(resourceOrigins.map(webOrigin));
    if (this.workspaces.size >= 64) fail('workspace_limit');
    this.protocol ??= this.browser.newBrowserCDPSession();
    const { context, browserContextId } = this.sharedContext
      ? { context: this.sharedContext } : await this.allocateContext();
    try {
      const ws = { id: randomUUID(), owner, name, agentName: displayName, context, browserContextId, origins, networkMode, mode: 'agent',
        resourceOrigins: resources, blockedOrigins: new Map(), generation: randomUUID(), control: new AbortController(), pages: new Map(), operations: new Map(), credentials: new Map(),
        tail: Promise.resolve(), lanes: new Map(), pending: 0, handoff: null, lastActiveAt: Date.now(),
        inputTail: Promise.resolve(), inputPending: 0,
        popupTasks: new Set(), jobs: new Set(), recent: null, credentialRequests: new Map() };
      ws.uploads = new UploadGrants();
      ws.downloads = new WorkspaceDownloads(ws, this.outputs);
      if (!this.sharedContext) {
        context.setDefaultTimeout(5000);
        ws.networkRelease = await this.routeWorkspace(context, ws);
        ws.onPage = page => this.register(ws, page);
        context.on('page', ws.onPage);
      }
      if (this.stopped || this.workspaces.size >= 64) fail('workspace_unavailable');
      this.workspaces.set(ws.id, ws);
      this.store.event(owner, ws.id, 'control', 'agent');
      this.notify(ws);
      return workspaceView(ws);
    } catch (error) {
      if (!this.sharedContext) await context.close().catch(() => {});
      throw error;
    }
  }

  async openWorkspace({ url, allowedOrigins = [], ...params }, owner) {
    const targetOrigin = webOrigin(url);
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 32) fail('invalid_params');
    const origins = [...new Set([targetOrigin, ...allowedOrigins])];
    const created = await this.create({ ...params, allowedOrigins: origins, networkMode: 'browser' }, owner);
    const ws = this.workspaces.get(created.workspaceId);
    if (!ws) fail('workspace_unavailable');
    try {
      return await this.enqueue(ws, job => this.open(ws, url, job), {kind:'openPage'});
    } catch (error) {
      // A takeover can happen while the first page is being opened. The
      // workspace and any opened tab then belong to the person taking control.
      if (ws.mode === 'agent' && !ws.finishing) await closeWorkspace(this, ws).catch(() => {});
      throw error;
    }
  }

  async allocateContext() {
    // Playwright does not expose the Chromium context ID. Serialize only
    // context allocation; never guess if another component creates one too.
    const protocol = await this.protocol;
    const allocation = this.creatingContext.then(async () => {
      const before = new Set((await protocol.send('Target.getBrowserContexts')).browserContextIds);
      const context = await this.browser.newContext({ acceptDownloads: true, serviceWorkers: 'block' });
      try {
        const { browserContextIds } = await protocol.send('Target.getBrowserContexts');
        const added = browserContextIds.filter(id => !before.has(id));
        if (added.length !== 1) fail('workspace_context_ambiguous');
        return { context, browserContextId: added[0] };
      } catch (error) {
        await context.close().catch(() => {});
        throw error;
      }
    });
    this.creatingContext = allocation.then(() => {}, () => {});
    return allocation;
  }

  routeWorkspace(target, ws) { return routeWorkspace(target, ws, !!this.sharedContext); }

  register(ws, page) {
    const existing = [...ws.pages.values()].find(tab => tab.page === page);
    if (existing) return existing;
    const tab = { id: randomUUID(), page, documentId: randomUUID(), refs:new Map(), frameRefs:new Map(), frameDocuments:new WeakMap(), frameIds:new WeakMap(), cursors:new Map(), frameRevision:0, title: '',
      heldKeys: new Set(), heldButtons: new Set() };
    ws.securityChallenge = null;
    this.store.remember(ws.owner, ws.id, 'page', tab.id);
    ws.pages.set(tab.id, tab);
    const releaseDialogs = attachDialogs(ws,tab,()=>{
      const info=tab.dialog.info;
      this.store.event(ws.owner,ws.id,'dialog','opened',info.operationId,null,{pageId:tab.id,resourceId:info.dialogId});
      this.notify(ws);
    });
    const navigated = frame => {
      if (frame !== page.mainFrame()) {
        tab.frameRevision++;
        tab.frameDocuments.delete(frame);
        clearFrameRefs(tab);
        if(ws.credentialRequests.get(tab.id)?.frameId) ws.credentialRequests.delete(tab.id);
        return;
      }
      ws.credentialRequests.delete(tab.id);
      tab.title = '';
      ws.securityChallenge = null;
      tab.documentId = randomUUID();
      this.invalidateObservation(tab);
      clearRefs(tab);
      this.notify(ws);
      if (tab.heldKeys.size || tab.heldButtons.size)
        ws.inputTail = ws.inputTail.then(() => releaseInput(tab));
      void refreshTitle(ws, tab);
    };
    const loaded = () => { void refreshTitle(ws, tab); };
    const response = async response => {
      try {
        if (response.request().resourceType() !== 'document') return;
        const headers = await response.allHeaders();
        const mitigated = headers['cf-mitigated']?.toLowerCase() === 'challenge';
        const cloudflare = headers.server?.toLowerCase().includes('cloudflare');
        if (!mitigated && !(cloudflare && response.status() >= 403)) return;
        const url = URL.parse(response.url());
        if (!url || !['http:', 'https:'].includes(url.protocol)) return;
        ws.securityChallenge = { provider: 'cloudflare', origin: url.origin,
          status: response.status(), detectedAt: Date.now() };
        this.store.event(ws.owner, ws.id, 'security', 'human_verification_required', null,
          { pageId: tab.id, origin: url.origin, status: response.status() });
        this.notify(ws);
      } catch { /* A closing page cannot change the workspace state. */ }
    };
    const closed = () => {
      releaseDialogs();
      void tab.summarySession?.detach().catch(() => {});
      clearRefs(tab);
      ws.pages.delete(tab.id);
      ws.credentialRequests.delete(tab.id);
      this.notify(ws);
    };
    const downloaded = artifact => {
      const resourceId=ws.downloads.receive(tab.id,artifact);
      if (!resourceId) return;
      const op=[...ws.jobs].find(job=>job.pageId===tab.id && job.dispatched);
      this.store.event(ws.owner,ws.id,'download','receiving',op?.receipt.operationId,null,{pageId:tab.id,resourceId});
    };
    page.on('download', downloaded);
    page.on('framenavigated', navigated);
    page.on('framedetached', navigated);
    page.on('domcontentloaded', loaded);
    page.on('response', response);
    page.on('close', closed);
    tab.unregister = () => {
      page.off('download', downloaded);
      page.off('framenavigated', navigated);
      page.off('framedetached', navigated);
      page.off('domcontentloaded', loaded);
      page.off('response', response);
      page.off('close', closed);
      closed();
    };
    return tab;
  }

  tab(ws, id) {
    const tab = ws.pages.get(id);
    if (!tab || tab.page.isClosed()) fail('page_not_found');
    return tab;
  }

  requireControl(ws, generation) {
    if (ws.finishing) fail('workspace_finishing');
    if (ws.securityChallenge) fail('human_verification_required');
    if (ws.mode !== 'agent') fail('workspace_under_user_control');
    if (ws.generation !== generation) fail('stale_control');
  }

  enqueue(ws, work, job) {
    this.requireControl(ws, ws.generation);
    if (ws.pending >= 128 || this.pending >= 512) fail('queue_full');
    const generation = ws.generation;
    if (job) {
      job.receipt ??= { state: 'queued', completedSteps: 0 };
      job.totalSteps ??= 1;
      job.receipt.totalSteps ??= job.totalSteps;
      job.receipt.phase ??= 'queued';
      job.receipt.stepKind ??= job.stepKind;
      ws.jobs.add(job);
    }
    const enqueuedAt = performance.now();
    this.pending++;
    ws.pending++;
    this.notify(ws);
    const signal = ws.control.signal;
    // Only operations targeting the same page depend on each other. Ownership
    // changes still drain the aggregate of all lanes before enabling input.
    const lane = job?.pageId || (job?.kind === 'openPage' ? Symbol() : 'workspace');
    const previous = ws.lanes.get(lane) || Promise.resolve();
    const result = previous.then(() => this.slots.run(ws.id, async () => {
      this.requireControl(ws, generation);
      if (job?.deadline !== undefined && Date.now() >= job.deadline) fail('run_timeout');
      if (job?.receipt.state === 'queued') {
        job.receipt.state = 'running';
        job.receipt.phase = 'running';
        if (job.digest) this.store.save(ws.owner, ws.id, job.digest, job.receipt);
      }
      this.notify(ws);
      const value = await work(job);
      if (job?.deadline !== undefined && Date.now() >= job.deadline) fail('run_timeout');
      this.requireControl(ws, generation);
      if (job?.receipt.state === 'running') {
        job.receipt.state = 'completed';
        job.receipt.phase = 'completed';
        job.receipt.completedSteps = job.totalSteps;
      }
      return value;
    }, signal, enqueuedAt)).catch(error => {
      if (job && ['queued','running'].includes(job.receipt.state)) {
        job.receipt.state = job.dispatched ? 'outcome_unknown' : job.cancel ? 'cancelled' : 'failed';
        job.receipt.phase = job.receipt.state;
        job.receipt.error = publicError(error);
      }
      throw error;
    }).finally(() => {
      this.pending--;
      ws.pending--;
      ws.lastActiveAt = Date.now();
      if (job) {
        if (job.receipt.state === 'cancelled' && job.controlTransferred)
          job.receipt.error = 'workspace_under_user_control';
        ws.jobs.delete(job);
        ws.recent = job;
        if (job.digest) this.store.save(ws.owner, ws.id, job.digest, job.receipt);
        if (ws.operations.size > 128) {
          for (const [id, entry] of ws.operations) {
            if (!ws.jobs.has(entry)) ws.operations.delete(id);
            if (ws.operations.size <= 128) break;
          }
        }
      }
      this.notify(ws);
    });
    const settled = result.catch(() => {});
    ws.lanes.set(lane, settled);
    ws.tail = Promise.all(ws.lanes.values()).then(() => {});
    void settled.then(() => { if (ws.lanes.get(lane) === settled) ws.lanes.delete(lane); });
    return result;
  }

  async openPopup(ws, opener, lease, url) {
    const check = () => {
      this.requireControl(ws,lease.generation);
      if (lease.op.cancel || ws.pages.get(opener.id)!==opener || opener.documentId!==lease.documentId ||
          allowedPageOrigin(ws,opener)!==lease.origin) fail('stale_document');
    };
    check();
    const child=await this.open(ws,url,undefined,{opener,lease,check});
    (lease.op.receipt.openedPageIds ??= []).push(child.pageId);
    this.store.event(ws.owner,ws.id,'popup','opened',lease.op.receipt.operationId,null,{pageId:opener.id,resourceId:child.pageId});
    return child;
  }

  async open(ws, url, job, popup) {
    const origin = webOrigin(url);
    if (!ws.origins.size && !ws.resourceOrigins.has(origin)) ws.origins.add(origin);
    if (!ws.origins.has(origin)) {
      rememberBlock(ws, origin, 'navigation', 'document', 'origin_denied');
      fail('origin_denied');
    }
    // Chromium can activate the first window in a new context even if
    // Playwright sends only page-local input later. Request background at
    // creation; the marker selects our exact target among concurrent popups.
    const marker = 'about:blank#open-browser-' + randomUUID();
    const protocol = await this.protocol;
    let targetId;
    let page;
    try {
      [page] = await Promise.all([
        ws.context.waitForEvent('page', { predicate: candidate => candidate.url() === marker, timeout: 5000 }),
        protocol.send('Target.createTarget', {
          url: marker, browserContextId: ws.browserContextId, background: true, focus: false,
        }).then(target => { targetId = target.targetId; }),
      ]);
    } catch {
      if (targetId) await protocol.send('Target.closeTarget', { targetId }).catch(() => {});
      fail('background_page_unavailable');
    }
    try {
      let networkRelease, networkSession;
      if (this.sharedContext) {
        if (ws.mode === 'closed') fail('workspace_closed');
        page.setDefaultTimeout(5000);
        const session = await ws.context.newCDPSession(page);
        const { targetInfo } = await session.send('Target.getTargetInfo');
        if (targetInfo.targetId !== targetId) {
          await session.detach().catch(() => {});
          fail('background_page_unavailable');
        }
        // An already-installed worker may serve an ordinary profile tab. This
        // override applies only to the workspace target and its navigation.
        await session.send('Network.setBypassServiceWorker', { bypass: true });
        networkSession = session;
        networkRelease = await this.routeWorkspace(page, ws);
      }
      if (ws.mode === 'closed') fail('workspace_closed');
      const tab = this.register(ws, page);
      tab.targetId = targetId;
      tab.createdByAgent = true;
      if (popup) {
        popup.check();
        tab.openerPageId=popup.opener.id;
        tab.openedByOperationId=popup.lease.op.receipt.operationId;
      }
      tab.networkRelease = networkRelease;
      tab.networkSession = networkSession;
      tab.releasePopups=await installPopupBridge(page, (token,href) => {
        const lease=tab.popupLease;
        if (!lease || token!==lease.token || Date.now()>lease.armDeadline) return;
        if (!href) {
          lease.until ??= Date.now()+2000;
          return;
        }
        if (!lease.until || Date.now()>lease.until) return;
        tab.popupLease=undefined;
        const task=this.openPopup(ws,tab,lease,href);
        // Drain already-started opens before local takeover or finishing releases pages.
        ws.popupTasks.add(task);
        task.then(()=>ws.popupTasks.delete(task),()=>ws.popupTasks.delete(task));
        lease.opening=task.catch(error=>{
          // A denied popup has a recorded origin; the originating click was still dispatched.
          if (error.code==='origin_denied') return;
          throw error;
        });
        return lease.opening.then(()=>{},()=>{});
      });
      if (ws.mode === 'agent') await this.setInputGuard?.(ws, tab, true);
      if (job) job.pageId = tab.id;
      this.notify(ws);
      if (this.sharedContext) await this.groupTab?.(page, ws.id, ws.name, ws.mode, ws.agentName, tab.id);
      let firstRequest;
      if (popup) {
        // Recheck in the actual request handler as well as before goto. A handoff
        // may arrive after Chromium schedules navigation but before routing.
        popup.check();
        firstRequest=async route=>{
          try { popup.check(); } catch { return route.abort('blockedbyclient'); }
          return route.fallback();
        };
        await page.route('**/*',firstRequest);
      }
      try {
        popup?.check();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        popup?.check();
      } finally {
        if (firstRequest) await page.unroute('**/*',firstRequest).catch(()=>{});
      }
      await refreshTitle(ws, tab);
      return { workspaceId: ws.id, pageId: tab.id };
    } catch (error) {
      await protocol.send('Target.closeTarget', { targetId }).catch(() => {});
      if (error.code) throw error;
      fail('navigation_failed');
    }
  }

  setCredential(ws, { origin, credentialRef, value }) {
    const target = webOrigin(origin);
    if ((ws.origins.size || ws.resourceOrigins.has(target)) && !ws.origins.has(target)) fail('origin_denied');
    stringParam(credentialRef, 160);
    stringParam(value, 8192);
    const key = target + '\n' + credentialRef;
    if (ws.credentials.size >= 128 && !ws.credentials.has(key)) fail('credential_limit');
    ws.credentials.set(key, value);
    for (const tab of ws.pages.values()) this.invalidateObservation(tab);
    for (const [pageId, request] of ws.credentialRequests) {
      if (request.origin === target && request.credentialRef === credentialRef)
        ws.credentialRequests.delete(pageId);
    }
    this.notify(ws);
    return { credentialRef, saved: true };
  }

  async previewPage(ws, tab) {
    const { documentId } = tab;
    const generation = ws.generation;
    this.requireControl(ws, generation);
    requirePageOrigin(ws, tab);
    const text = await tab.page.evaluate(inspectDocument, true);
    this.requireControl(ws, generation);
    if (documentId !== tab.documentId) fail('stale_observation');
    requirePageOrigin(ws, tab);
    return { workspaceId: ws.id, pageId: tab.id, observationId: randomUUID(), documentId, controlGeneration: generation,
      text: redact(ws, text) };
  }

  async observeFrameControls(ws,tab,options,offsets,readOnly,check) {
    const refs=new Map(), next=new Map(), frames=[];
    let remaining=options.limit,remainingText=8000;
    try {
      for(const frame of tab.page.frames().filter(frame=>frame.parentFrame())) {
        if(offsets && !offsets.has(frame)) continue;
        if(!await frameAllowed(frame,ws.origins)) continue;
        if(frames.length>=16 || (!remaining && !remainingText)) {next.set(frame,offsets?.get(frame) ?? {});continue;}
        let document=tab.frameDocuments.get(frame);
        if(!document) {
          const frameId=tab.frameIds.get(frame) ?? randomUUID();
          tab.frameIds.set(frame,frameId);
          document={frameId,documentId:randomUUID(),origin:webOrigin(frame.url())};
          tab.frameDocuments.set(frame,document);
        }
        const settings={name:options.name,region:options.region,padding:options.padding,limit:remaining,textLimit:remainingText,
          ...offsets?.get(frame),origins:[...ws.origins]};
        let snapshot,nodes,handles;
        try {
          snapshot=await frame.evaluateHandle(inspectDocument,settings);
          const summary=await snapshot.evaluate(result=>result?.summary);
          if(!summary || summary.origin!==document.origin || !ws.origins.has(summary.origin)) continue;
          if(!readOnly) {
            nodes=await snapshot.getProperty('nodes');
            handles=await nodes.getProperties();
          }
          if(!await frameAllowed(frame,ws.origins) || tab.frameDocuments.get(frame)!==document) fail('stale_observation');
          const elements=summary.details.map(({role,name,options,...state},i)=>{
            const info={role,name:redact(ws,name),...state};
            if(readOnly) return info;
            const handle=handles.get(String(i))?.asElement();
            if(!handle) fail('stale_observation');
            const ref=randomUUID();
            refs.set(ref,{frame,document,handle,actor:this.actors.getStore()});
            handles.delete(String(i));
            const choices=options?.map(({label,value})=>({label:redact(ws,label),value:redact(ws,value)}));
            return {...info,ref,...(choices && {options:choices})};
          });
          frames.push({...document,text:observationText(ws,summary.text,summary.textWindowInfo),elements});
          remaining-=elements.length;remainingText-=summary.text.length;
          if(summary.next) next.set(frame,summary.next);
        } finally {
          await Promise.all([snapshot,nodes,...(handles?.values() ?? [])].filter(Boolean).map(h=>h.dispose().catch(()=>{})));
        }
        check();
      }
      return {refs,next,frames};
    } catch(error) {
      for(const {handle} of refs.values()) await handle.dispose().catch(()=>{});
      throw error;
    }
  }

  async checkFrameRef(ws,tab,ref,entry) {
    if(!entry) return;
    if(tab.frameRefs.get(ref)!==entry || tab.frameDocuments.get(entry.frame)!==entry.document ||
       entry.actor!==this.actors.getStore() || !ws.origins.has(entry.document.origin) ||
       URL.parse(entry.frame.url())?.origin!==entry.document.origin || !await frameAllowed(entry.frame,ws.origins))
      fail('stale_ref');
  }

  async checkSemanticTarget(ws,tab,ref,entry,handle,kind) {
    await this.checkFrameRef(ws,tab,ref,entry);
    if(await handle.ownerFrame()!==(entry?.frame ?? tab.page.mainFrame())) fail('stale_ref');
    const targetFrame=entry?.frame ?? tab.page.mainFrame();
    if(!await targetFrame.evaluate(inspectDocument,{foregroundTarget:handle})) fail('target_obscured');
    if(tab.strictLocator && !entry &&
        !await targetFrame.evaluate(inspectDocument,{locator:tab.strictLocator,expectedNode:handle,origins:[...ws.origins]}))
      fail('stale_ref');
    const error=await handle.evaluate((node,kind)=>{
      if(!node.isConnected) return 'stale_ref';
      for(let el=node;el;el=el.assignedSlot || el.parentElement || el.getRootNode().host) {
        if(el.matches('[inert],[aria-hidden="true" i],[data-open-browser-private]')) return 'stale_ref';
      }
      if(kind==='setChecked' && !(node.control ?? node).matches('input[type="checkbox"],input[type="radio"],[role="checkbox"],[role="switch"],[role="radio"]')) return 'invalid_actions';
      if(node.localName==='label' && !['click','setChecked'].includes(kind)) return 'invalid_actions';
      if(kind==='fill' && node.matches('input[type="password"]')) return 'credential_ref_required';
    },kind);
    if(error) fail(error);
  }

  observationRequest(tab,ws,params,readOnly) {
    const actor=this.actors.getStore();
    if(params.cursor!==undefined) {
      if(typeof params.cursor!=='string' || Object.keys(params).some(k=>!['workspaceId','pageId','cursor'].includes(k))) fail('invalid_params');
      const entry=tab.cursors.get(params.cursor);
      if(!entry || entry.actor!==actor || entry.readOnly!==readOnly || entry.expires<Date.now() ||
          entry.generation!==ws.generation || entry.documentId!==tab.documentId ||
          (entry.request.frameControls && entry.frameRevision!==tab.frameRevision)) fail('stale_cursor');
      return entry.request;
    }
    const {name,region,locator,limit=180,frameControls=false,includeFrames=false}=params;
    if(locator !== undefined) {
      const valid = obj => obj && typeof obj.role==='string' && obj.role.trim() && obj.role.length<=80 &&
        typeof obj.name==='string' && obj.name.trim() && obj.name.length<=160;
      if(!valid(locator) || (locator.within!==undefined && !valid(locator.within)) ||
          name!==undefined || region!==undefined || includeFrames || frameControls) fail('invalid_params');
    }
    if(!Number.isInteger(limit) || limit<1 || limit>180 || typeof frameControls!=='boolean' || typeof includeFrames!=='boolean' ||
       (name!==undefined && (typeof name!=='string' || !name.trim() || name.length>160)) ||
       (region!==undefined && (!region || !['x','y','width','height'].every(k=>Number.isSafeInteger(region[k])) ||
          region.x<0 || region.y<0 || region.width<=0 || region.height<=0))) fail('invalid_params');
    return {name,region,locator,limit,frameControls,includeFrames};
  }

  continuation(tab,ws,readOnly,request,mainNext,frameNext) {
    if(!mainNext && !frameNext?.size) return {truncated:false};
    const nextCursor=randomUUID();
    for(const [key,entry] of tab.cursors) if(entry.expires<Date.now()) tab.cursors.delete(key);
    if(tab.cursors.size>=64) tab.cursors.delete(tab.cursors.keys().next().value);
    tab.cursors.set(nextCursor,{actor:this.actors.getStore(),readOnly,generation:ws.generation,documentId:tab.documentId,
      frameRevision:tab.frameRevision,expires:Date.now()+60_000,request:{...request,...(mainNext ?? {elementOffset:null,textOffset:null}),frameOffsets:frameNext}});
    return {truncated:true,nextCursor};
  }

  async observe(ws, tab, params = {}, readOnly = false) {
    const request=this.observationRequest(tab,ws,params,readOnly);
    const {includeFrames,frameControls,frameOffsets,...options}=request;
    options.padding=Math.max(0,...Array.from(ws.credentials.values(),v=>v.length-1));
    requirePageOrigin(ws,tab);
    const documentId=tab.documentId,controlGeneration=ws.generation,frameRevision=tab.frameRevision;
    const cacheable = !readOnly && !request.cursor && !request.name && !request.region && !request.locator &&
      !request.includeFrames && !request.frameControls && request.limit === 180;
    const revision = cacheable ? await this.observationRevision(tab) : null;
    if (cacheable && revision !== null && tab.observationCache?.documentId === documentId &&
        tab.observationCache.controlGeneration === controlGeneration && tab.observationCache.revision === revision) {
      return { ...tab.observationCache.payload, observationId: randomUUID(), blockedRequests: blockedRequests(tab.page) };
    }
    const check=()=>{
      this.requireControl(ws,controlGeneration);
      requirePageOrigin(ws,tab);
      if(tab.documentId!==documentId || ws.pages.get(tab.id)!==tab || tab.page.isClosed() ||
          (frameControls && tab.frameRevision!==frameRevision)) fail('stale_observation');
    };
    const frameResult=frameControls ? await this.observeFrameControls(ws,tab,options,frameOffsets,readOnly,check) : null;
    const frames=frameResult?.frames ?? (includeFrames ? await observeFrames(tab.page,ws.origins,(value,window)=>observationText(ws,value,window),options.padding) : undefined);
    if (readOnly) {
      const {text,details,match,foreground,next,textWindowInfo}=await this.readOnlyObserver(tab,[...ws.origins],options);
      check();
      this.requireControl(ws, controlGeneration);
      requirePageOrigin(ws, tab);
      if (tab.documentId !== documentId || ws.pages.get(tab.id) !== tab || tab.page.isClosed()) fail('stale_observation');
      return { workspaceId: ws.id, pageId: tab.id, observationId: randomUUID(), documentId, controlGeneration, text:observationText(ws,text,textWindowInfo),
        elements:details.map(({role,name,options,...state})=>({role,name:redact(ws,name),...state})),
        ...(foreground && {foreground:{...foreground,name:redact(ws,foreground.name)}}), ...observationMatch(ws,match), ...this.continuation(tab,ws,true,request,next,frameResult?.next),
        ...(frames && {frames}), blockedRequests: blockedRequests(tab.page) };
    }
    let published=false;
    const priorRefs = [...tab.refs.keys()];
    const previousNodes = tab.observedNodes;
    let snapshot,nodes,freshNodes,handles;
    try {
      snapshot=await tab.page.evaluateHandle(inspectDocument,{...options,previousNodes});
      const {text,details,match,foreground,previousIndices,next,textWindowInfo}=await snapshot.evaluate(result=>result.summary);
      nodes = await snapshot.getProperty('nodes');
      if (previousNodes) freshNodes = await snapshot.getProperty('freshNodes');
      handles = await (freshNodes ?? nodes).getProperties();
      requirePageOrigin(ws, tab);
      if (tab.documentId !== documentId || ws.mode !== 'agent' || ws.generation !== controlGeneration ||
          ws.pages.get(tab.id) !== tab || tab.page.isClosed() || previousNodes !== tab.observedNodes) fail('stale_observation');

      check();
      const nextRefs = new Map();
      const elements = details.map(({role, name, options,...state}, index) => {
        const existing = priorRefs[previousIndices?.[index]];
        const ref = existing ?? randomUUID();
        const element = existing ? tab.refs.get(existing) : handles.get(String(index))?.asElement();
        if (!element || nextRefs.has(ref)) fail('stale_observation');
        nextRefs.set(ref, element);
        const choices = options?.map(option => ({value: redact(ws, option.value), label: redact(ws, option.label)}));
        return { ref, role, name: redact(ws, name), ...state, ...(choices && { options: choices }) };
      });
      // Publish only after every target and the control generation are verified.
      for (const [ref, handle] of tab.refs) {
        if (!nextRefs.has(ref)) void handle.dispose().catch(() => {});
      }
      tab.refs=nextRefs;
      tab.strictLocator=options.locator;
      clearFrameRefs(tab);
      if(frameResult) tab.frameRefs=frameResult.refs;
      published=true;
      tab.observedNodes = nodes;
      nodes = undefined;
      handles = undefined;
      void previousNodes?.dispose().catch(() => {});
      tab.lastObservation={observationId: randomUUID(), documentId,controlGeneration,text:observationText(ws,text,textWindowInfo),elements};
      const result = {workspaceId:ws.id,pageId:tab.id,...tab.lastObservation,
        ...(foreground && {foreground:{...foreground,name:redact(ws,foreground.name)}}), ...observationMatch(ws,match), ...this.continuation(tab,ws,false,request,next,frameResult?.next),
        ...(frames && { frames }), blockedRequests: blockedRequests(tab.page) };
      if (cacheable && revision !== null)
        tab.observationCache = { documentId, controlGeneration, revision, payload: result };
      return result;
    } finally {
      if(!published && frameResult) for(const {handle} of frameResult.refs.values()) void handle.dispose().catch(()=>{});
      const release = [snapshot, nodes, freshNodes, ...(handles?.values() ?? [])].filter(Boolean);
      await Promise.all(release.map(handle => handle.dispose().catch(() => {})));
    }
  }

  async observeAndAct(ws, params) {
    const tab = this.tab(ws, params.pageId);
    const { workspaceId, pageId, operationId, actions, timeoutMs, observeAfter,
      documentId, controlGeneration, ...observeParams } = params;
    if (workspaceId !== ws.id || documentId !== undefined || controlGeneration !== undefined)
      fail('invalid_params');
    const observation = await this.enqueue(ws, () => this.observe(ws, tab, observeParams),
      { kind: 'observe', pageId: tab.id });
    const receipt = this.act(ws, { workspaceId: ws.id, pageId: tab.id, operationId,
      documentId: observation.documentId, controlGeneration: observation.controlGeneration,
      actions, timeoutMs, observeAfter });
    return { observation, receipt };
  }

  actionDigest(params) {
    const {pageId,documentId,controlGeneration,actions,observeAfter,timeoutMs}=params;
    if(params[workflowOrigin]) return createHash('sha256').update(JSON.stringify(
      ['runWorkflow',pageId,documentId,controlGeneration,params[workflowOrigin],actions,timeoutMs])).digest('hex');
    return createHash('sha256').update(JSON.stringify(['act',pageId,documentId,controlGeneration,actions,observeAfter,timeoutMs])).digest('hex');
  }

  act(ws, params) {
    const { operationId, pageId, documentId, controlGeneration, actions, timeoutMs } = params;
    stringParam(operationId, 160);
    if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > limits.runTimeoutMs)) fail('invalid_params');
    if (params.observeAfter !== undefined && !['full', 'delta'].includes(params.observeAfter)) fail('invalid_params');
    if (!Array.isArray(actions) || !actions.length || actions.length > 32) fail('invalid_actions');
    for (const action of params[workflowOrigin] ? [] : actions) {
      if (action?.kind === 'upload') {
        stringParam(action.fileId,160);
        stringParam(action.ref,160);
        continue;
      }
      if (action?.kind === 'spatial') {
        stringParam(action.frameId,160);
        validateVisualAction(action.action);
        continue;
      }
      if (action?.kind === 'wait') {
        if ([action.text, action.url, action.element, action.absent, action.navigation].filter(value => value !== undefined).length !== 1) fail('invalid_actions');
        if (action.text !== undefined) stringParam(action.text, 256);
        if (action.url !== undefined) webOrigin(stringParam(action.url, 65536));
        if (action.navigation !== undefined && action.navigation !== 'commit') fail('invalid_actions');
        if (action.element !== undefined || action.absent !== undefined) {
          const target=action.element ?? action.absent;
          stringParam(target?.role, 80);
          stringParam(target?.name, 160);
          const stateKeys=['checked','pressed','expanded','selected'];
          for(const [key,val] of Object.entries(target)) {
            if(key==='role' || key==='name') continue;
            if(action.absent || !stateKeys.includes(key) || (typeof val!=='boolean' &&
                !(['pressed','checked'].includes(key) && val==='mixed'))) fail('invalid_actions');
          }
        }
        if (action.timeoutMs !== undefined && (!Number.isInteger(action.timeoutMs) ||
            action.timeoutMs < 1 || action.timeoutMs > 10000)) fail('invalid_actions');
        continue;
      }
      if (!action || typeof action.ref !== 'string' || !['click', 'doubleClick', 'hover', 'press', 'scroll', 'drag', 'fill', 'fillCredential', 'select','setChecked'].includes(action.kind))
        fail('invalid_actions');
      if (action.kind === 'setChecked' && typeof action.checked !== 'boolean') fail('invalid_actions');
      if (action.kind === 'select' && (typeof action.value !== 'string' || action.value.length > 256)) fail('invalid_actions');
      if (action.kind === 'fill' && (typeof action.value !== 'string' || action.value.length > 8192))
        fail('invalid_actions');
      if (action.kind === 'press' && (typeof action.key !== 'string' || action.key.length > 80)) fail('invalid_actions');
      if (action.kind === 'scroll' && (!Number.isFinite(action.deltaY) || !Number.isFinite(action.deltaX ?? 0))) fail('invalid_actions');
      if (action.kind === 'drag' && (typeof action.toRef !== 'string' || action.toRef.length > 160)) fail('invalid_actions');
      if (action.kind === 'fillCredential') stringParam(action.credentialRef, 160);
    }
    const digest = this.actionDigest(params);
    const past = ws.operations.get(operationId);
    if (past) {
      if (digest !== past.digest) fail('operation_id_conflict');
      return this.receiptView(ws, past);
    }
    const prior = this.store.get(ws.owner, ws.id, operationId);
    if (prior) {
      if (prior.digest !== digest) fail('operation_id_conflict');
      return prior.receipt;
    }
    const tab = this.tab(ws, pageId);
    this.requireControl(ws, controlGeneration);
    requirePageOrigin(ws, tab);
    if (tab.documentId !== documentId) fail('stale_document');
    if (ws.operations.size >= 2048) fail('operation_limit');
    const receipt = { operationId, pageId, state: 'queued', phase: 'queued', totalSteps: actions.length, completedSteps: 0 };
    if (ws.pending >= 128 || this.pending >= 512) fail('queue_full');
    this.store.save(ws.owner, ws.id, digest, receipt);
    const budgetMs = timeoutMs ?? limits.runTimeoutMs;
    const op = { digest, receipt, cancel: false, controller: new AbortController(), kind: 'act', pageId, totalSteps: actions.length,
      deadline: Date.now() + budgetMs, budgetMs };
    const run = this.enqueue(ws, () => params[workflowOrigin] ? performWorkflow(this,ws,tab,params,op,fail) :
      perform(this,ws,tab,params,op), op);
    ws.operations.set(operationId, op);
    run.catch(error => {
      if (['queued','running'].includes(receipt.state)) {
        receipt.state = op.cancel ? 'cancelled' : 'failed';
        receipt.phase = receipt.state;
        receipt.error = publicError(error);
      }
    });
    return { ...receipt };
  }

  receiptView(ws, op) {
    const result = { ...op.receipt };
    const tab = ws.pages.get(op.pageId);
    const recent = tab?.actionObservation;
    if (recent?.operationId === op.receipt.operationId && ws.mode === 'agent' &&
        recent.generation === ws.generation && recent.documentId === tab.documentId && allowedPageOrigin(ws, tab))
      Object.assign(result, recent.payload);
    return result;
  }

  async desktopNavigate(ws, { pageId, action, url }, newTab) {
    const tab = newTab ? null : this.tab(ws, pageId);
    if (newTab) action = 'go';
    if (!['go', 'back', 'forward', 'reload'].includes(action) ||
        (action !== 'go' && url !== undefined)) fail('invalid_params');
    const origin = action === 'go' ? webOrigin(stringParam(url, 65536)) : null;
    const { controlGeneration } = await this.handOff(ws, pageId, false);
    return enqueueHuman(ws, controlGeneration, async check => {
      if (tab) this.tab(ws, tab.id);
      // Only an explicitly typed address grants a new origin. Redirects and
      // subresources still pass through the existing workspace network rules.
      if (origin) ws.origins.add(origin);
      if (newTab) return this.open(ws, url);
      try { return await navigatePage(ws, tab, action, url, check); }
      catch (error) {
        if (error.code) throw error;
        fail('navigation_failed');
      }
    });
  }

  handOff(ws, pageId, focus, expectedGeneration) {
    return handOff(this, ws, pageId, focus, expectedGeneration);
  }

  returnToAgent(ws, expectedGeneration) {
    return returnToAgent(this, ws, expectedGeneration);
  }

  async shutdown() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.sweep);
    await Promise.all([...this.workspaces.values()].map(async ws => {
      await ws.finishing?.promise;
      if (this.workspaces.has(ws.id)) await closeWorkspace(this, ws);
    }));
    if (this.protocol) await this.protocol.then(session => session.detach()).catch(() => {});
    this.store.close();
  }
}
