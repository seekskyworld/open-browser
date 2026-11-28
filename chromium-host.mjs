import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';

import { managedInput } from './managed-input.mjs';
import { pageActivity } from './page-activity.mjs';
import { desktopCapabilities } from './capability-matrix.mjs';

export const extensionId = 'ehmdmliolflappfnmopemgojhbiilmpl';
const workerUrl = 'chrome-extension://' + extensionId + '/worker.js';
const isHost = worker => worker.url() === workerUrl;
const WORKER_EVAL_TIMEOUT_MS = 5000;

export function classifyExtensionFailure({ dispatched = false } = {}) {
  return dispatched
    ? { code: 'host_timeout', message: 'open-browser 扩展已收到请求，但本机服务未在时限内返回。请检查服务状态后重试。' }
    : { code: 'host_unavailable', message: 'open-browser 扩展未连接到本机服务，请先启动应用后重试。' };
}

function extensionError(code, message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code });
}

async function evaluateWorker(host, pageFunction, arg) {
  let timer;
  try {
    return await Promise.race([
      host.evaluate(pageFunction, arg),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(extensionError(
          'extension_worker_timeout',
          'open-browser 扩展 service worker 响应超时，请检查扩展状态后重试.',
        )), WORKER_EVAL_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// No page bindings, shared secret or loopback listener. Only our packaged
// extension's service worker can submit desktop control requests.
export async function chromiumHost(context) {
  const findWorker = () => context.serviceWorkers().find(isHost);
  const worker = async () => {
    const current = findWorker();
    if (current) return current;
    try {
      return await context.waitForEvent('serviceworker', { predicate: isHost, timeout: 10000 });
    } catch (cause) {
      throw extensionError('extension_unavailable', 'open-browser 工作区扩展未运行，请重新启动应用或重新加载扩展.', cause);
    }
  };
  let initial = await worker();
  const currentVersion = host => evaluateWorker(host, () => globalThis.openBrowserGroupVersion);
  if (await currentVersion(initial) !== 12) {
    // A persistent Chromium profile can start the previous cached MV3 worker.
    const replacement = context.waitForEvent('serviceworker', { predicate: isHost, timeout: 10000 });
    try {
    [initial] = await Promise.all([replacement, evaluateWorker(initial, () => {
        setTimeout(() => chrome.runtime.reload(), 0);
      })]);
    } catch (cause) {
      // Chromium can defer the replacement worker until its next profile launch.
      throw Object.assign(new Error('工作区扩展已请求更新', { cause }), { code: 'extension_reload' });
    }
    if (await currentVersion(initial) !== 12) throw new Error('请重新构建 open-browser 工作区扩展。');
  }
  let stopped = false;
  let lastState;
  const effects = pageActivity();
  const configuredGuard = process.env.OPEN_BROWSER_INPUT_GUARD?.trim().toLowerCase();
  // All packaged profiles use the page-level fallback unless a Chromium build
  // provides the native event-aware guard. `off` remains an explicit
  // diagnostics override.
  const guardMode = configuredGuard || 'fallback';
  if (!['off', 'fallback', 'native'].includes(guardMode))
    throw extensionError('invalid_input_guard_mode', 'OPEN_BROWSER_INPUT_GUARD 必须是 off、fallback 或 native。');
  const guarded = guardMode !== 'off';
  const setInputGuard = guarded ? managedInput(context, tab => {
    void worker().then(host => globalThis.openBrowserInputHint
      ? evaluateWorker(host, pageId => globalThis.openBrowserInputHint(pageId), tab.id)
      : undefined).catch(() => {});
  }, { allowFallback: guardMode === 'fallback', forceFallback: guardMode === 'fallback' }) : undefined;
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
    await evaluateWorker(host, value => globalThis.openBrowserReply(value), response);
  }
  async function requests(call) {
    while (!stopped) {
      try {
        const host = await worker();
        const request = await evaluateWorker(host, () => globalThis.openBrowserNext());
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
          needsHumanVerification: activity.needsHumanVerification,
        }));
        const signature = JSON.stringify(state);
        if (signature !== lastState) {
          await evaluateWorker(await worker(), items => globalThis.openBrowserSync(items), state);
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
  const frontTab = async () => evaluateWorker(await worker(), () => globalThis.openBrowserFrontTab());
  let lastBar;
  async function watchFrontTab(send) {
    let frontRevision = 0;
    while (!stopped) {
    const bar = await frontTab().catch(() => null);
      const signature = JSON.stringify(bar);
      if (!stopped && signature !== lastBar) {
        lastBar = signature;
        send(bar);
      }
      const host = await worker().catch(() => null);
      if (!host) { await delay(300); continue; }
      const next = await evaluateWorker(host, ({ after }) => {
        if (typeof globalThis.openBrowserWaitFrontTabChange !== 'function') return null;
        return globalThis.openBrowserWaitFrontTabChange(after);
      }, { after: frontRevision }).catch(() => null);
      if (next === null) { await delay(300); continue; }
      frontRevision = await next;
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
    setInputGuard,
    withAgentInput: setInputGuard?.withAgentInput,
    inputGuardMode: guarded ? guardMode : 'off',
    onActionTarget(event) { if (!stopped) effects.target(event); },
    onActivity(view) { if (!stopped) { effects.update(view); changed(); } },
    async groupTab(page, workspaceId, name, mode, agentName, pageId, controlGeneration, preserveGroup) {
      const session = await context.newCDPSession(page);
      let retained = false;
      try {
        const { targetInfo } = await session.send('Target.getTargetInfo');
        const args = { targetId: targetInfo.targetId, workspaceId, name, mode, agentName, pageId, controlGeneration, preserveGroup };
        await evaluateWorker(await worker(), info => globalThis.openBrowserGroup(info), args);
        if (pageId && !effects.has(pageId)) {
          effects.track(page, session, workspaceId, pageId);
          retained = true;
        }
        lastState = undefined;
        changed();
      } finally { if (!retained) await session.detach().catch(() => {}); }
    },
    async releaseTab(page, workspaceId, pageId) {
      if (!page.isClosed()) await evaluateWorker(await worker(), params => globalThis.openBrowserRelease(params), {workspaceId,pageId});
      await effects.release(pageId);
      lastState = undefined;
      changed();
    },
    async show() { await evaluateWorker(await worker(), () => globalThis.openBrowserShow()); },
    clickBar,
    start(call, onBar) {
      void requests(call);
      void sync(() => call('listWorkspaces'));
      if (onBar) void watchFrontTab(onBar);
    },
    stop() { stopped = true; changed(); },
  };
}
