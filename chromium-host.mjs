import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import { pageActivity } from './page-activity.mjs';
import { desktopCapabilities } from './capability-matrix.mjs';

export const extensionId = 'ehmdmliolflappfnmopemgojhbiilmpl';
const workerUrl = 'chrome-extension://' + extensionId + '/worker.js';
const isHost = worker => worker.url() === workerUrl;

// No page bindings, shared secret or loopback listener. Only our packaged
// extension's service worker can submit desktop control requests.
export async function chromiumHost(context) {
  const findWorker = () => context.serviceWorkers().find(isHost);
  const worker = async () => findWorker() || context.waitForEvent('serviceworker', { predicate: isHost, timeout: 10000 });
  let initial = await worker();
  const currentVersion = host => host.evaluate(() => globalThis.openBrowserGroupVersion);
  if (await currentVersion(initial) !== 10) {
    // A persistent Chromium profile can start the previous cached MV3 worker.
    const replacement = context.waitForEvent('serviceworker', { predicate: isHost, timeout: 10000 });
    try {
      [initial] = await Promise.all([replacement, initial.evaluate(() => {
        setTimeout(() => chrome.runtime.reload(), 0);
      })]);
    } catch (cause) {
      // Chromium can defer the replacement worker until its next profile launch.
      throw Object.assign(new Error('工作区扩展已请求更新', { cause }), { code: 'extension_reload' });
    }
    if (await currentVersion(initial) !== 10) throw new Error('请重新构建 open-browser 工作区扩展。');
  }
  let stopped = false;
  let lastState;
  const effects = pageActivity();
  let revision = 0, wakeSync;
  function changed() { revision++; wakeSync?.(); }
  const allowed = new Set(desktopCapabilities);

  async function respond(host, request, call) {
    let response;
    try {
      if (!allowed.has(request.method)) throw Object.assign(new Error(), { code: 'unknown_method' });
      response = { id: request.id, result: await call(request.method, request.params || {}) };
    } catch (error) {
      response = { id: request.id, error: error.code || 'operation_failed' };
    }
    await host.evaluate(value => globalThis.openBrowserReply(value), response);
  }
  async function requests(call) {
    while (!stopped) {
      try {
        const host = await worker();
        const request = await host.evaluate(() => globalThis.openBrowserNext());
        if (!request || stopped) continue;
        // Accept takeover while a longer popup operation (such as login) is in flight.
        void respond(host, request, call).catch(() => {});
      } catch {
        if (!stopped) await delay(300);
      }
    }
  }
  async function sync(list) {
    while (!stopped) {
      const startRevision = revision;
      try {
        const state = (await list()).map(({workspaceId, agentName, name, mode, activity, pages, controlGeneration}) => ({
          workspaceId, agentName, name, mode, controlGeneration, pages: pages.map(({pageId}) => ({pageId})),
          running: activity.running, currentPageId: activity.current?.pageId, stepKind: activity.current?.stepKind,
          dispatchState: activity.current?.dispatchState, phase: activity.phase, needsCredential: activity.needsCredential,
        }));
        const signature = JSON.stringify(state);
        if (signature !== lastState) {
          await (await worker()).evaluate(items => globalThis.openBrowserSync(items), state);
          lastState = signature;
        }
      } catch { lastState = undefined; }
      if (!stopped && revision === startRevision) await new Promise(resolve => {
        const timer = setTimeout(resolve, 750);
        wakeSync = () => { clearTimeout(timer); resolve(); };
      });
      wakeSync = undefined;
    }
  }
  const frontTab = async () => (await worker()).evaluate(() => globalThis.openBrowserFrontTab());
  let lastBar;
  async function watchFrontTab(send) {
    while (!stopped) {
      const bar = await frontTab().catch(() => null);
      const signature = JSON.stringify(bar);
      if (!stopped && signature !== lastBar) {
        lastBar = signature;
        send(bar);
      }
      // Foreground tab changes have no stable cross-process event. Keep a
      // modest fallback poll while workspace revisions remain event-driven.
      await delay(300);
    }
  }
  async function clickBar(frame, call) {
    const front = await frontTab();
    if (!front || !['agent', 'human'].includes(front.mode) ||
        ['workspaceId', 'pageId', 'windowId', 'mode', 'controlGeneration'].some(key => frame[key] !== front[key])) return;
    if (frame.action === 'delivery') {
      const workspace = await call('getWorkspace', { workspaceId: front.workspaceId });
      const keepPageIds = (workspace.pages || []).map(page => page.pageId);
      await call('finishWorkspace', {
        workspaceId: front.workspaceId,
        keepPageIds,
        operationId: randomUUID(),
        controlGeneration: front.controlGeneration,
      });
      return;
    }
    const { workspaceId, pageId, controlGeneration } = front;
    await call(front.mode === 'agent' ? 'takeControl' : 'returnToAgent', { workspaceId, pageId, controlGeneration });
  }
  return {
    onActionTarget(event) { if (!stopped) effects.target(event); },
    onActivity(view) { if (!stopped) { effects.update(view); changed(); } },
    async groupTab(page, workspaceId, name, mode, agentName, pageId) {
      const session = await context.newCDPSession(page);
      let retained = false;
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        const args = { targetId: targetInfo.targetId, workspaceId, name, mode, agentName, pageId };
        await (await worker()).evaluate(info => globalThis.openBrowserGroup(info), args);
        if (pageId && !effects.has(pageId)) {
          effects.track(page, session, workspaceId, pageId);
          retained = true;
        }
        lastState = undefined;
        changed();
      } finally { if (!retained) await session.detach().catch(() => {}); }
    },
    async releaseTab(page, workspaceId, pageId) {
      if (!page.isClosed()) await (await worker()).evaluate(params => globalThis.openBrowserRelease(params), {workspaceId,pageId});
      await effects.release(pageId);
      lastState = undefined;
      changed();
    },
    async show() { await (await worker()).evaluate(() => globalThis.openBrowserShow()); },
    clickBar,
    start(call, onBar) {
      void requests(call);
      void sync(() => call('listWorkspaces'));
      if (onBar) void watchFrontTab(onBar);
    },
    stop() { stopped = true; changed(); },
  };
}
