'use strict';

const defaultPopup = 'popup.html';
const tabKey = tabId => 'tab:' + tabId;
const runningTabs = new Set();
const activityFrames = ['▶', '▸', '▹', '▸'];
let animation, frame = 0;

function showRunning(tabId, running) {
  if (running) runningTabs.add(tabId);
  else runningTabs.delete(tabId);
  if (runningTabs.size && !animation) {
    animation = setInterval(() => {
      frame = (frame + 1) % activityFrames.length;
      for (const id of runningTabs) {
        chrome.action.setBadgeText({ tabId: id, text: activityFrames[frame] }).catch(() => showRunning(id, false));
      }
    }, 480);
  }
  if (!runningTabs.size && animation) { clearInterval(animation); animation = undefined; }
}

const actionStates = {
  running: ['▶', '#1556b0', '执行中'],
  queued: ['…', '#6757a4', '排队中'],
  actionability: ['⌁', '#1556b0', '检查目标'],
  dispatching: ['▶', '#1556b0', '正在派发'],
  waiting: ['…', '#6757a4', '等待页面'],
  verifying: ['✓', '#526675', '核对结果'],
  needs_credential: ['!', '#a72f24', '等待凭据'],
  needs_human_verification: ['!', '#a75d08', '需要人工验证'],
  completed: ['✓', '#526675', '已完成'],
  failed: ['!', '#a72f24', '执行失败'],
  outcome_unknown: ['?', '#a75d08', '结果待核实'],
  cancelled: ['−', '#626977', '已取消'],
  idle: ['·', '#626977', '等待指令'],
  human: ['人', '#176344', '人工控制'],
  transferring: ['↔', '#926407', '交接中'],
};

async function writeAction(tabId, record) {
  const key = tabKey(tabId);
  if (!record) {
    showRunning(tabId, false);
    await chrome.storage.session.remove(key);
    if (!await chrome.tabs.get(tabId).catch(() => null)) return;
    await Promise.all([
      chrome.action.setPopup({ tabId, popup: defaultPopup }),
      chrome.action.setTitle({ tabId, title: 'open-browser 工作区' }),
      chrome.action.setBadgeText({ tabId, text: '' }),
    ]);
    return;
  }
  await chrome.storage.session.set({ [key]: record });
  const phase = record.mode !== 'agent' ? record.mode : record.needsHumanVerification ? 'needs_human_verification' : record.needsCredential ? 'needs_credential' : record.phase;
  showRunning(tabId, ['running', 'actionability', 'dispatching', 'waiting', 'verifying'].includes(phase));
  const [text, color, status] = actionStates[phase] || actionStates.idle;
  const panel = phase === 'needs_credential' || phase === 'needs_human_verification' || phase === 'transferring' || !record.controlGeneration;
  const steps = { click: '点击', fill: '填写', fillCredential: '填写凭据' };
  const step = phase === 'running' && record.dispatchState ? (record.dispatchState === 'dispatched' ? '已派发' : '等待页面') : phase === 'running' ? steps[record.stepKind] : '';
  const hint = record.mode === 'human' ? '点击交回 Agent' : panel ? '点击打开工作区面板' : '点击接管';
  await Promise.all([
    chrome.action.setBadgeText({ tabId, text }),
    chrome.action.setBadgeBackgroundColor({ tabId, color }),
    chrome.action.setTitle({ tabId, title: (record.agentName || 'Agent') + ' · ' + (step || status) + ' · ' + hint }),
    chrome.action.setPopup({ tabId, popup: panel ? defaultPopup : '' }),
  ]);
}

async function registerAction(tabId, state) {
  if (!state.pageId) return;
  const key = tabKey(tabId);
  const existing = (await chrome.storage.session.get(key))[key];
  const same = existing?.targetId === state.targetId && existing?.workspaceId === state.workspaceId && existing?.pageId === state.pageId;
  const record = { ...(same ? existing : {}), ...state, tabId };
  if (same && existing.mode !== state.mode && !state.controlGeneration) delete record.controlGeneration;
  await writeAction(tabId, record);
}

// Reconcile only records registered by the host, independent of user tab-group edits.
async function syncTabActions(byId, slots) {
  await Promise.all(Object.entries(slots).filter(([key]) => key.startsWith('tab:')).map(([key, previous]) =>
    forWorkspace(previous.workspaceId, async () => {
      const current = (await chrome.storage.session.get(key))[key];
      if (!current || current.targetId !== previous.targetId) return;
      const state = byId.get(current.workspaceId);
      const pageIds = state?.pageIds || state?.pages?.map(p => typeof p === 'string' ? p : p.pageId);
      if (!state || (pageIds && !pageIds.includes(current.pageId))) return writeAction(current.tabId, null);
      const working = ['running', 'queued'].includes(state.phase);
      const running = state.running?.find(job => job.pageId === current.pageId);
      const phase = running ? (running.phase || 'running') : working && current.pageId !== state.currentPageId ? 'idle' : state.phase;
      const record = { ...current, mode: state.mode, agentName: state.agentName, phase,
        stepKind: running ? (running.stepKind || state.stepKind) : null,
        dispatchState: running ? (running.dispatchState || state.dispatchState) : null,
        needsCredential: state.needsCredential, controlGeneration: state.controlGeneration };
      if (JSON.stringify(record) !== JSON.stringify(current)) await writeAction(current.tabId, record);
    })));
}

chrome.tabs.onRemoved.addListener(tabId => {
  showRunning(tabId, false);
  void chrome.storage.session.remove(tabKey(tabId));
});

async function openWorkspacePanel(tabId, delivery = false) {
  const url = chrome.runtime.getURL(defaultPopup) + (Number.isInteger(tabId) ? '#tab-' + tabId + (delivery ? '-delivery' : '') : '');
  await chrome.windows.create({ url, type: 'popup', width: 380, height: 510, focused: true });
}

const toggling = new Set();

async function clickTabAction(tab) {
  const key = tabKey(tab.id);
  const record = (await chrome.storage.session.get(key))[key];
  if (!record) return openWorkspacePanel(tab.id);
  if (toggling.has(record.workspaceId)) return;
  toggling.add(record.workspaceId);
  try {
    const workspace = await hostRequest('getWorkspace', { workspaceId: record.workspaceId });
    if (!workspace.pages.some(p => p.pageId === record.pageId) || workspace.mode !== record.mode ||
        workspace.controlGeneration !== record.controlGeneration || workspace.mode === 'transferring' ||
        (workspace.mode === 'agent' && workspace.activity?.needsCredential)) return openWorkspacePanel(tab.id);
    const target = { workspaceId: record.workspaceId, pageId: record.pageId, controlGeneration: record.controlGeneration };
    await hostRequest(workspace.mode === 'human' ? 'returnToAgent' : 'takeControl', target);
  } catch {
    await openWorkspacePanel(tab.id);
  } finally {
    toggling.delete(record.workspaceId);
  }
}

chrome.action.onClicked.addListener(clickTabAction);
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'workspace-panel', title: '工作区面板', contexts: ['action'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'workspace-panel') void openWorkspacePanel(tab?.id);
});
