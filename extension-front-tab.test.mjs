import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { launchChromiumShell } from './chromium-shell.mjs';

test('the focused native tab must have its own host registration', async t => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'open-browser-front-tab-'));
  let context;
  t.after(async () => {
    try { await context?.close(); }
    finally { await rm(profileDir, { recursive: true, force: true }); }
  });
  context = await launchChromiumShell({ profileDir, headless: true });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const front = () => worker.evaluate(() => globalThis.openBrowserFrontTab());
  const ordinary = await context.newPage();
  await ordinary.bringToFront();
  assert.equal(await front(), null);

  const managed = await context.newPage();
  await managed.bringToFront();
  const session = await context.newCDPSession(managed);
  const { targetInfo } = await session.send('Target.getTargetInfo');
  await session.detach();
  const record = { workspaceId: 'workspace', pageId: 'managed', name: 'Task', agentName: 'kernel',
    mode: 'agent', controlGeneration: 'generation', phase: 'running', targetId: targetInfo.targetId };
  const registered = await worker.evaluate(state => globalThis.openBrowserGroup(state), record);
  const active = await front();
  assert.equal(active.workspaceId, record.workspaceId);
  assert.equal(active.pageId, record.pageId);
  assert.equal(active.controlGeneration, record.controlGeneration);
  assert.equal(active.mode, record.mode);
  assert.equal(active.agentName, record.agentName);
  assert.equal(active.phase, record.phase);
  assert.ok(Number.isInteger(active.windowId) && Number.isFinite(active.left) && Number.isFinite(active.top));
  assert.ok(active.width > 0 && active.height > 0 && active.viewportWidth > 0);

  await worker.evaluate(() => globalThis.openBrowserInputHint('different-page'));
  assert.equal((await front()).inputBlocked, undefined);
  await worker.evaluate(id => globalThis.openBrowserInputHint(id), record.pageId);
  assert.equal((await front()).inputBlocked, true);
  assert.equal((await front()).mode, 'agent', 'a blocked click only hints at the takeover button');
  await ordinary.bringToFront();
  await worker.evaluate(async groupId => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.group({ tabIds: tab.id, groupId });
  }, registered.groupId);
  assert.equal(await front(), null, 'a user-grouped ordinary tab remains unregistered');
  await managed.bringToFront();
  assert.equal((await front()).pageId, record.pageId);
  await worker.evaluate(id => chrome.windows.update(id, { state: 'minimized' }), active.windowId);
  assert.equal(await front(), null, 'a minimized window cannot own the control');
  await worker.evaluate(id => chrome.windows.update(id, { state: 'normal', focused: true }), active.windowId);
  await worker.evaluate(() => chrome.windows.create({ url: 'popup.html', type: 'popup', focused: true }));
  assert.equal(await front(), null, 'the extension panel is not the managed browser window');
});
