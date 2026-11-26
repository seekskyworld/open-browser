'use strict';

function workspaceTitle({ agentName, name, mode }) {
  const agent = agentName || 'Agent';
  const task = typeof name === 'string' && name.trim() ? name.trim() : '未命名任务';
  const title = agent + ' · ' + task;
  return mode === 'human' ? '人工 · ' + title : title;
}

function workspaceNeedsName({ name }) {
  return !(typeof name === 'string' && name.trim());
}

globalThis.openBrowserWorkspaceTitle = workspaceTitle;
globalThis.openBrowserWorkspaceNeedsName = workspaceNeedsName;
