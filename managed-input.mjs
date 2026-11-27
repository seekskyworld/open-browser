import { ServiceError } from './workspace-state.mjs';

// The browser owns a guard token for the lifetime of its dedicated CDP session.
export function managedInput(context, onBlocked) {
  const sessions = new WeakMap();
  const disconnectedSessions = new WeakSet();
  return async function setGuard(tab, enabled, onLost) {
    const { page } = tab;
    let session = sessions.get(page);
    if (page.isClosed()) return;
    if (!enabled) {
      if (session) {
        sessions.delete(page);
        try { await session.detach(); }
        catch (error) {
          if (!page.isClosed() && !disconnectedSessions.has(session)) {
            sessions.set(page, session);
            throw error;
          }
        }
      }
      return;
    }
    if (session) return;
    session = await context.newCDPSession(page);
    try {
      session.once('close', () => {
        disconnectedSessions.add(session);
        if (sessions.get(page) !== session) return;
        sessions.delete(page);
        if (!page.isClosed()) onLost?.();
      });
      session.on('Input.openBrowserInputBlocked', () => {
        if (sessions.get(page) === session) onBlocked(tab);
      });
      let timer;
      try {
        await Promise.race([
          session.send('Input.setOpenBrowserInputGuard', {enabled:true}),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(Error('Input guard acknowledgement timed out')), 5000);
          }),
        ]);
      } finally { clearTimeout(timer); }
      if (disconnectedSessions.has(session)) throw Error('input guard session closed');
      sessions.set(page, session);
    } catch (cause) {
      await session.detach().catch(() => {});
      if (!page.isClosed()) throw Object.assign(new ServiceError('input_guard_unavailable'), { cause });
    }
  };
}
