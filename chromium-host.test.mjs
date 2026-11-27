import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromiumHost, extensionId } from './chromium-host.mjs';
import { launchChromiumShell } from './chromium-shell.mjs';
import { BrowserService } from './engine-service.mjs';

test('Chromium new-tab cockpit shows running agents and history only', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'open-browser-chromium-test-'));
  let context, host, engine, newtab;
  try {
    context = await launchChromiumShell({ profileDir: path.join(stateDir, 'profile'), headless: true });
    context.setDefaultTimeout(15_000);
    host = await chromiumHost(context);
    engine = new BrowserService(context.browser(), {
      sharedContext: context, groupTab: host.groupTab, releaseTab: host.releaseTab,
      onActivity: host.onActivity, onActionTarget: host.onActionTarget,
    });
    const call = (method, params = {}) => engine.call(method, params, 'local');
  let showUnnamed = false;
    host.start(async (method, params) => {
      if (method === 'listAgentHistory') return [{ workspaceId: 'history', agentName: '历史 Agent', name: '已完成任务', state: 'completed', createdAt: Date.now(), recentOperation: { kind: 'act', state: 'completed', completedSteps: 2 } }];
      if (method === 'listEvents') return { events: [{ kind: 'operation', state: 'completed', operationId: 'history-op', completedSteps: 2 }], nextCursor: 1 };
    if (method === 'listWorkspaces' && showUnnamed) return [{ workspaceId: 'unnamed', agentName: 'Agent', name: '', mode: 'agent', pages: [], activity: {} }];
      return call(method, params);
    });
    assert.equal(context.pages()[0]?.url(), 'chrome-extension://' + extensionId + '/newtab.html');
    newtab = await context.newPage();
    await newtab.goto('chrome-extension://' + extensionId + '/newtab.html');
    await newtab.locator('#status').waitFor();
    await newtab.locator('#empty').waitFor();
    assert.match(await newtab.locator('#empty').innerText(), /当前没有正在运行的 Agent/);
    await newtab.getByText('历史 Agent · 已完成任务').waitFor();
    await newtab.getByRole('button', { name: '查看记录' }).last().click();
    await newtab.getByText(/operation · 已完成 · 2 步 · history-/).waitFor();
    assert.match(await newtab.locator('#agent-prompt').inputValue(), /open-browser Skill/);
    assert.equal(await newtab.locator('#copy-prompt').innerText(), '复制提示词');
    await newtab.locator('#copy-prompt').click();
    await newtab.getByRole('button', { name: '已复制' }).waitFor();
    assert.equal(await newtab.locator('#profile-task, #start, #with-password').count(), 0);
    showUnnamed = true;
    await newtab.reload();
    await newtab.getByText('Agent · 未命名任务').waitFor();
    await newtab.getByText('请为此任务命名').waitFor();
  } finally {
    host?.stop();
    await newtab?.close();
    await engine?.shutdown();
    await context?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('existing Chromium profiles hide saved group chips while retaining bookmark bar settings', async () => {
  const profileDir = await mkdtemp(path.join(tmpdir(),'open-browser-layout-'));
  let context;
  try {
    const directory = path.join(profileDir,'Default');
    await mkdir(directory);
    const file = path.join(directory,'Preferences');
    await writeFile(file,JSON.stringify({bookmark_bar:{show_tab_groups:true,show_on_all_tabs:true},vertical_tabs:{enabled:true}}));
    context = await launchChromiumShell({profileDir,headless:true});
    const settings = await context.newPage();
    await settings.goto('chrome://settings/appearance');
    assert.equal(await settings.evaluate(async () => (await chrome.settingsPrivate.getPref('bookmark_bar.show_tab_groups')).value),false);
    await context.close();
    context = null;
    const stored = JSON.parse(await readFile(file,'utf8'));
    assert.equal(stored.bookmark_bar.show_tab_groups,false);
    assert.equal(stored.bookmark_bar.show_on_all_tabs,true);
    assert.equal(stored.ack_existing_ntp_extensions,true);
  } finally {
    await context?.close();
    await rm(profileDir,{recursive:true,force:true});
  }
});

test('native new tabs route to the cockpit without an extension new-tab override', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'open-browser-new-tab-route-'));
  let context;
  try {
    context = await launchChromiumShell({ profileDir: path.join(stateDir, 'profile'), headless: true });
    const session = await context.browser().newBrowserCDPSession();
    const created = context.waitForEvent('page', { timeout: 10_000 });
    await session.send('Target.createTarget', { url: 'chrome://newtab/', background: true, focus: false });
    const page = await created;
    await page.waitForURL(`chrome-extension://${extensionId}/newtab.html`);
    const ordinary = await context.newPage();
    await ordinary.goto('data:text/html,<title>ordinary</title>');
    assert.equal(await ordinary.title(), 'ordinary');
    await session.detach();
  } finally {
    await context?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
