'use strict';

importScripts('workspace-title.js', 'tab-action.js');
globalThis.openBrowserGroupVersion = 11;

const groupsInProgress = new Map();

async function groupPage(state) {
  const { targetId, workspaceId } = state;
  const target = (await chrome.debugger.getTargets()).find(t => t.type === 'page' && t.id === targetId);
  if (!Number.isInteger(target?.tabId)) throw new Error('target_not_found');
  const tab = await chrome.tabs.get(target.tabId);
  const key = 'group:' + workspaceId + ':' + tab.windowId;
  const stored = (await chrome.storage.session.get(key))[key];
  const group = Number.isInteger(stored) ? await chrome.tabGroups.get(stored).catch(() => null) : null;
  let groupId;
  if (group && group.windowId === tab.windowId) {
    groupId = group.id;
    if (groupId !== tab.groupId) await chrome.tabs.group({ groupId, tabIds: tab.id });
  } else {
    groupId = await chrome.tabs.group({ tabIds: tab.id, createProperties: { windowId: tab.windowId } });
    await chrome.storage.session.set({ [key]: groupId });
  }
  await updateGroup(groupId, group, state);
  await registerAction(tab.id, state);
  await chrome.storage.session.set({ ['page:' + workspaceId + ':' + state.pageId]: { tabId: tab.id } });
  return { groupId, tabId: tab.id };
}

const agentColors = ['blue', 'purple', 'cyan', 'orange', 'pink'];

function agentColor(name = 'Agent') {
  let hash = 0;
  for (const character of name) hash = (Math.imul(hash, 31) + character.codePointAt(0)) >>> 0;
  return agentColors[hash % agentColors.length];
}

async function updateGroup(groupId, group, state) {
  const { mode, phase, needsCredential, needsHumanVerification } = state;
  const attention = needsCredential || needsHumanVerification || ['failed', 'outcome_unknown', 'needs_credential', 'needs_human_verification'].includes(phase);
  const color = mode === 'human' ? 'green' : mode === 'transferring' ? 'yellow' : attention ? 'red' : agentColor(state.agentName);
  const title = workspaceTitle(state);
  if (group?.color !== color || group?.title !== title) await chrome.tabGroups.update(groupId, { title, color });
}

// Called in this worker's isolated extension context through the app-owned pipe.
function forWorkspace(key, operation) {
  const preceding = groupsInProgress.get(key) || Promise.resolve();
  const result = preceding.catch(() => {}).then(operation);
  groupsInProgress.set(key, result);
  const cleanup = () => { if (groupsInProgress.get(key) === result) groupsInProgress.delete(key); };
  result.then(cleanup, cleanup);
  return result;
}

globalThis.openBrowserGroup = params => forWorkspace(params.workspaceId, () => groupPage(params));

globalThis.openBrowserRelease = ({workspaceId,pageId}) => forWorkspace(workspaceId, async () => {
  const mappingKey = 'page:' + workspaceId + ':' + pageId;
  const mapping = (await chrome.storage.session.get(mappingKey))[mappingKey];
  let tabId = mapping?.tabId;
  if (!Number.isInteger(tabId)) {
    // Compatibility fallback for profiles created before the page index.
    const slots = await chrome.storage.session.get(null);
    tabId = Object.entries(slots).find(([key,tab]) => key.startsWith('tab:') &&
      tab.workspaceId === workspaceId && tab.pageId === pageId)?.[1]?.tabId;
  }
  if (!Number.isInteger(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const groupKey = 'group:' + workspaceId + ':' + tab?.windowId;
  const group = (await chrome.storage.session.get(groupKey))[groupKey];
  if (tab && tab.groupId >= 0 && group === tab.groupId)
    await chrome.tabs.ungroup(tabId);
  await writeAction(tabId,null);
  await chrome.storage.session.remove(mappingKey);
});

let inputHint;
globalThis.openBrowserFrontTab = async function () {
  // A single browser snapshot keeps the active tab and its native window bounds together.
  const win = await chrome.windows.getLastFocused({ populate: true }).catch(() => null);
  if (!win?.focused || win.type !== 'normal' || win.state === 'minimized') return null;
  const tab = win.tabs?.find(item => item.active && item.windowId === win.id);
  if (!Number.isInteger(tab?.id) || !Number.isFinite(tab.width) || tab.width <= 0) return null;
  const { id: windowId, left, top, width, height } = win;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  const key = tabKey(tab.id);
  const record = (await chrome.storage.session.get(key))[key];
  if (record?.tabId !== tab.id || !record.targetId || !record.workspaceId ||
      !record.pageId || !record.controlGeneration) return null;
  const { workspaceId, pageId, controlGeneration, mode, agentName, phase } = record;
  return { workspaceId, pageId, controlGeneration, mode, agentName: agentName || 'Agent', phase: phase || 'idle',
    ...(inputHint?.pageId === pageId && inputHint.generation === controlGeneration &&
      mode === 'agent' && inputHint.until > Date.now() && { inputBlocked: true }),
    dispatchState: record.dispatchState || null,
    windowId, left, top, width, height, viewportWidth: tab.width };
};

globalThis.openBrowserInputHint = async function (pageId) {
  const front = await globalThis.openBrowserFrontTab();
  if (front?.pageId !== pageId || front.mode !== 'agent' || front.inputBlocked) return;
  const hint = {pageId, generation:front.controlGeneration, until:Date.now() + 1500};
  inputHint = hint;
  markFrontTabChanged();
  const [tab] = await chrome.tabs.query({active:true, windowId:front.windowId});
  const record = tab && (await chrome.storage.session.get(tabKey(tab.id)))[tabKey(tab.id)];
  if (record?.pageId === pageId && record.mode === 'agent') {
    showRunning(tab.id, false);
    await chrome.action.setBadgeText({tabId:tab.id, text:'接管'}).catch(() => {});
  }
  setTimeout(async () => {
    if (hint === inputHint) inputHint = null;
    markFrontTabChanged();
    if (record) await forWorkspace(record.workspaceId, async () => {
      const current = (await chrome.storage.session.get(tabKey(tab.id)))[tabKey(tab.id)];
      if (current?.pageId === pageId) await writeAction(tab.id, current);
    }).catch(() => {});
  }, 1500);
};

let frontTabRevision = 0;
const frontTabWaiters = new Set();
function markFrontTabChanged() {
  frontTabRevision++;
  for (const resolve of frontTabWaiters) resolve(frontTabRevision);
  frontTabWaiters.clear();
}
chrome.tabs.onActivated.addListener(markFrontTabChanged);
chrome.windows.onFocusChanged.addListener(markFrontTabChanged);
chrome.tabs.onRemoved.addListener(markFrontTabChanged);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status || changeInfo.groupId !== undefined || changeInfo.windowId !== undefined) markFrontTabChanged();
});
globalThis.openBrowserWaitFrontTabChange = function (after) {
  if (!Number.isSafeInteger(after) || frontTabRevision !== after) return Promise.resolve(frontTabRevision);
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      frontTabWaiters.delete(done);
      resolve(frontTabRevision);
    }, 3000);
    const done = value => {
      clearTimeout(timer);
      frontTabWaiters.delete(done);
      resolve(value);
    };
    frontTabWaiters.add(done);
  });
};

globalThis.openBrowserDelivery = async target => {
  const [tab] = await chrome.tabs.query({active:true,windowId:target.windowId});
  if (!tab) return;
  const key = tabKey(tab.id);
  const row = (await chrome.storage.session.get(key))[key];
  if (row?.workspaceId === target.workspaceId && row.pageId === target.pageId &&
      row.controlGeneration === target.controlGeneration) await openWorkspacePanel(tab.id,true);
};

globalThis.openBrowserSync = async function (states) {
  const byId = new Map(states.map(state => [state.workspaceId, state]));
  const slots = await chrome.storage.session.get(null);
  await syncTabActions(byId, slots);
  await Promise.all(Object.entries(slots).filter(([key]) => key.startsWith('group:')).map(([key, id]) => {
    const wsId = key.slice(6, key.lastIndexOf(':'));
    return forWorkspace(wsId, async () => {
      if ((await chrome.storage.session.get(key))[key] !== id) return;
      const state = byId.get(wsId);
      const group = state && await chrome.tabGroups.get(id).catch(() => null);
      if (group) await updateGroup(id, group, state);
      else await chrome.storage.session.remove(key);
    });
  }));
  void chrome.runtime.sendMessage({event:'workspaceChanged'}).catch(() => {});
};

globalThis.openBrowserShow = async function () {
  const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const current = windows.find(w => w.focused) || await chrome.windows.getLastFocused({ windowTypes: ['normal'] }).catch(() => null);
  if (current) return (await chrome.windows.update(current.id, { focused: true, ...(current.state === 'minimized' ? { state: 'normal' } : {}) })).id;
  return (await chrome.windows.create({ focused: true })).id;
};

const newtabMethods = new Set(['listWorkspaces', 'listAgentHistory', 'listEvents']);
const methods = new Set(['listUploads','grantUpload','revokeUpload','respondDialog','listDownloads','cancelDownload','keepDownload','visualStatus','listOperations','listEvents', 'listWorkspaces', 'getWorkspace', 'takeControl', 'returnToAgent', 'grantOrigin', 'resolveCredential', 'finishWorkspace']);
const pending = new Map();
const queued = [];
let waiting;

function hostFailure(request) {
  if (request?.dispatchedAt) return {
    code: 'host_timeout',
    message: 'open-browser 扩展已收到请求，但本机服务未在时限内返回。请检查服务状态后重试。',
  };
  return {
    code: 'host_unavailable',
    message: 'open-browser 扩展未连接到本机服务，请先启动应用后重试。',
  };
}

// Kept on the worker for the new-tab diagnostics and focused integration tests.
globalThis.openBrowserClassifyHostFailure = hostFailure;

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  const source = sender.url?.split('#')[0];
  const popup = source === chrome.runtime.getURL('popup.html');
  const newtab = source === chrome.runtime.getURL('newtab.html');
  if (sender.id !== chrome.runtime.id || (!popup && !newtab) ||
      (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  const allowed = newtab ? newtabMethods : methods;
  if (!allowed.has(message?.method) || !message.params || typeof message.params !== 'object' || Array.isArray(message.params)) {
    respond({ error: 'invalid_request' });
    return false;
  }
  hostRequest(message.method, message.params).then(result => respond({ result }), error => respond({ error: error.message }));
  return true;
});

function hostRequest(method, params) {
  if (pending.size >= 64) return Promise.reject(new Error('queue_full'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      const index = queued.findIndex(request => request.id === id);
      if (index >= 0) queued.splice(index, 1);
      const failure = hostFailure(request);
      const error = new Error(failure.message);
      error.code = failure.code;
      reject(error);
    }, 60_000);
    pending.set(id, { resolve, reject, timer });
    const request = { id, method, params };
    if (waiting) {
      request.dispatchedAt = Date.now();
      waiting(request);
    }
    else queued.push(request);
  });
}

globalThis.openBrowserNext = function () {
  if (queued.length) {
    const request = queued.shift();
    request.dispatchedAt = Date.now();
    return request;
  }
  if (waiting) waiting(null);
  return new Promise(resolve => {
    const timer = setTimeout(() => waiting(null), 3000);
    waiting = request => {
      clearTimeout(timer);
      waiting = undefined;
      resolve(request);
    };
  });
};

globalThis.openBrowserReply = function ({ id, result, error }) {
  const call = pending.get(id);
  if (!call) return false;
  pending.delete(id);
  clearTimeout(call.timer);
  if (error) call.reject(new Error(error));
  else call.resolve(result);
  return true;
};
