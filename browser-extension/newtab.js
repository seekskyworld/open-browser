'use strict';

const el = id => document.getElementById(id);
const phases = globalThis.openBrowserPhaseLabels;
const modes = globalThis.openBrowserModeLabels;

async function call(method, params = {}) {
  const reply = await chrome.runtime.sendMessage({ method, params });
  if (!reply || reply.error) throw new Error(reply?.error || 'host_unavailable');
  return reply.result;
}

function notify(message) {
  el('notice').textContent = message;
  el('notice').hidden = !message;
  el('notice').classList.toggle('error', Boolean(message));
}

function friendlyError(error) {
  const code = error?.message || '';
  if (code === 'host_unavailable' || code === 'host_timeout') return 'open-browser 服务未连接，请先启动应用后点击刷新。';
  return code || '暂时无法读取 Agent 状态，请点击刷新重试。';
}

function stateLabel(workspace) {
  if (workspace.activity?.needsCredential) return '等待凭据';
  return modes[workspace.mode] || phases[workspace.activity?.current?.phase] || phases[workspace.activity?.phase] || '待命';
}

const formatWorkspaceTitle = globalThis.openBrowserWorkspaceTitle;
const needsTaskName = globalThis.openBrowserWorkspaceNeedsName;

function line(text, className = '') {
  const node = document.createElement('span');
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function renderWorkspaces(items) {
  el('workspace-count').textContent = items.length ? `${items.length} 个` : '';
  el('empty').hidden = items.length > 0;
  el('workspaces').replaceChildren(...items.map(workspace => {
    const card = document.createElement('article');
    card.className = 'card live-card';
    const title = document.createElement('strong');
    title.textContent = formatWorkspaceTitle(workspace);
    const status = line(stateLabel(workspace), 'state');
    const current = workspace.activity?.current;
    const detail = line(current
      ? `${current.kind || '操作'} · ${current.completedSteps || 0}/${current.totalSteps || 0} 步`
      : `${workspace.pages?.length || 0} 个页面 · 暂无正在执行的操作`, 'detail');
    const agent = line(workspace.agentName || 'Agent', 'agent-name');
    card.append(title, agent, status, detail);
    if (needsTaskName(workspace)) card.append(line('请为此任务命名', 'name-hint'));
    return card;
  }));
}

function operationLabel(operation) {
  if (!operation) return '暂无操作记录';
  const phase = operation.phase || operation.state;
  const progress = operation.totalSteps ? `${operation.completedSteps || 0}/${operation.totalSteps} 步` : `${operation.completedSteps || 0} 步`;
  return `${operation.kind || '操作'} · ${phases[phase] || phase} · ${progress}`;
}

function formatTime(value) {
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(value);
}

function renderHistory(items) {
  el('history-count').textContent = items.length ? `${items.length} 条` : '';
  el('history-empty').hidden = items.length > 0;
  el('history').replaceChildren(...items.map(item => {
    const row = document.createElement('article');
    row.className = 'history-row';
    const main = document.createElement('div');
    main.append(line(formatWorkspaceTitle(item), 'history-title'), line(operationLabel(item.recentOperation), 'detail'));
    if (needsTaskName(item)) main.append(line('请为此任务命名', 'name-hint'));
    const meta = document.createElement('div');
    meta.className = 'history-meta';
    meta.append(line(phases[item.state] || item.state || '已完成', `history-state ${item.state || ''}`));
    const time = formatTime(item.updatedAt || item.createdAt);
    if (time) meta.append(line(time, 'detail'));
    row.append(main, meta);
    return row;
  }));
}

async function refresh() {
  try {
    const [workspaces, history] = await Promise.all([
      call('listWorkspaces'),
      call('listAgentHistory', { limit: 24 }),
    ]);
    renderWorkspaces(workspaces);
    renderHistory(history);
    el('status').textContent = '本机服务已连接';
    notify('');
  } catch (error) {
    el('status').textContent = '服务未连接';
    notify(friendlyError(error));
  }
}

el('refresh').onclick = () => void refresh();
el('copy-prompt').onclick = async () => {
  const prompt = el('agent-prompt').value;
  try {
    await navigator.clipboard.writeText(prompt);
  } catch {
    el('agent-prompt').select();
    document.execCommand('copy');
    el('agent-prompt').setSelectionRange(0, 0);
  }
  const button = el('copy-prompt');
  const label = button.textContent;
  button.textContent = '已复制';
  setTimeout(() => { button.textContent = label; }, 1600);
};
void refresh();
setInterval(() => void refresh(), 5000);
