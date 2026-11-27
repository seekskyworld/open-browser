import { ServiceError } from './workspace-state.mjs';

// The preferred guard is implemented inside Chromium. A stock Chromium build
// uses a page-level capture fallback, which blocks page input while allowing
// the service to open a short dispatch window for one Agent action. The
// fallback avoids keeping a CDP session attached after native support has been
// ruled out because the extension also uses chrome.debugger.
const fallbackSource = `(() => {
  const key = '__openBrowserInputGuard';
  const current = globalThis[key];
  if (current) { current.enabled = true; return; }
  const state = { enabled: true };
  const block = event => {
    if (!state.enabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  for (const type of ['click','dblclick','mousedown','mouseup','mousemove','mouseenter','mouseleave',
    'pointerdown','pointerup','pointermove','pointercancel','wheel','touchstart','touchmove','touchend',
    'contextmenu','keydown','keypress','keyup','beforeinput','input','change'])
    document.addEventListener(type, block, true);
  globalThis[key] = state;
})();`;

function fallbackExpression(enabled) {
  return `globalThis.__openBrowserInputGuard && (globalThis.__openBrowserInputGuard.enabled = ${enabled ? 'true' : 'false'})`;
}

async function setFallbackState(page, enabled) {
  await page.evaluate(fallbackExpression(enabled)).catch(() => {});
  // Init scripts cannot be removed from a Playwright page. Append a small
  // state update so a later navigation preserves the handoff decision.
  await page.addInitScript({ content: fallbackExpression(enabled) }).catch(() => {});
}

export function managedInput(context, onBlocked, { allowFallback = false, forceFallback = false } = {}) {
  const sessions = new WeakMap();
  const disconnectedSessions = new WeakSet();

  async function setGuard(tab, enabled, onLost) {
    const { page } = tab;
    let entry = sessions.get(page);
    if (page.isClosed()) return;
    if (!enabled) {
      if (!entry) return;
      if (entry.mode === 'fallback') {
        await setFallbackState(page, false);
        sessions.delete(page);
        return;
      }
      try { await entry.session.send('Input.setOpenBrowserInputGuard', { enabled: false }); }
      catch (error) {
        if (!page.isClosed() && !disconnectedSessions.has(entry.session)) throw error;
      }
      sessions.delete(page);
      try { await entry.session.detach(); }
      catch (error) {
        if (!page.isClosed() && !disconnectedSessions.has(entry.session)) {
          sessions.set(page, entry);
          throw error;
        }
      }
      return;
    }
    if (entry) return;
    if (forceFallback && allowFallback) {
      try {
        await page.addInitScript({ content: fallbackSource });
        await page.evaluate(fallbackSource);
        entry = { mode: 'fallback', depth: 0, transition: Promise.resolve() };
        sessions.set(page, entry);
      } catch (cause) {
        if (!page.isClosed()) throw Object.assign(new ServiceError('input_guard_unavailable'), { cause });
      }
      return;
    }
    const session = await context.newCDPSession(page);
    entry = { session, mode: 'native', depth: 0, transition: Promise.resolve() };
    try {
      session.once('close', () => {
        disconnectedSessions.add(session);
        if (sessions.get(page) !== entry) return;
        sessions.delete(page);
        if (!page.isClosed()) onLost?.();
      });
      session.on('Input.openBrowserInputBlocked', () => {
        if (sessions.get(page) === entry) onBlocked(tab);
      });
      let timer;
      try {
        await Promise.race([
          session.send('Input.setOpenBrowserInputGuard', { enabled: true }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('Input guard acknowledgement timed out')), 5000);
          }),
        ]);
      } finally { clearTimeout(timer); }
      if (disconnectedSessions.has(session)) throw Error('input guard session closed');
      sessions.set(page, entry);
    } catch (cause) {
      const unsupported = /wasn.t found|not found|unknown command/i.test(String(cause?.message));
      await session.detach().catch(() => {});
      if (!allowFallback || !unsupported) {
        if (!page.isClosed()) throw Object.assign(new ServiceError('input_guard_unavailable'), { cause });
        return;
      }
      try {
        await page.addInitScript({ content: fallbackSource });
        await page.evaluate(fallbackSource);
        entry = { mode: 'fallback', depth: 0, transition: Promise.resolve() };
        sessions.set(page, entry);
      } catch (fallbackCause) {
        if (!page.isClosed()) throw Object.assign(new ServiceError('input_guard_unavailable'), { cause: fallbackCause });
      }
    }
  }

  setGuard.withAgentInput = async (tab, work) => {
    const entry = sessions.get(tab.page);
    if (!entry || entry.mode !== 'fallback') return work();
    entry.depth++;
    if (entry.depth === 1) {
      entry.transition = entry.transition.then(() => setFallbackState(tab.page, false));
      await entry.transition;
    }
    try { return await work(); }
    finally {
      entry.depth--;
      if (entry.depth === 0) {
        entry.transition = entry.transition.then(() => setFallbackState(tab.page, true));
        await entry.transition.catch(() => {});
      }
    }
  };

  setGuard.mode = tab => sessions.get(tab.page)?.mode || null;
  return setGuard;
}
