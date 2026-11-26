import { request as httpClient } from 'playwright-core';
const passiveResources = new Set(['stylesheet', 'image', 'font', 'media']);
const blocked = new WeakMap();

export function blockedRequests(page) {
  return [...(blocked.get(page)?.values() || [])];
}
export function rememberBlock(ws, origin, scope, resourceType, reason) {
  const key = scope + '\n' + origin;
  if (!ws.blockedOrigins.has(key) && ws.blockedOrigins.size === 32)
    ws.blockedOrigins.delete(ws.blockedOrigins.keys().next().value);
  ws.blockedOrigins.set(key, { origin, scope, resourceType, reason });
}
function record(page, origin, resourceType, reason) {
  if (!page) return;
  let entries = blocked.get(page);
  if (!entries) { entries = new Map(); blocked.set(page, entries); }
  const key = JSON.stringify([origin, resourceType, reason]);
  if (!entries.has(key) && entries.size === 16) entries.delete(entries.keys().next().value);
  entries.set(key, { origin, resourceType, reason });
}

export async function routeWorkspace(target, ws, shared) {
  if (ws.networkMode === 'browser') return async () => {};
  let released = false;
  let anonymousContext;
  let anonymousContextPromise;
  const getAnonymousContext = async () => {
    anonymousContextPromise ??= httpClient.newContext().then(context => {
      anonymousContext = context;
      return context;
    });
    return anonymousContextPromise;
  };
  async function httpRoute(route) {
    const req = route.request(), type = req.resourceType();
    let response;
    let page;
    try {
      try { page = req.frame().page(); } catch { /* The first popup request may have no frame yet. */ }
      function allowed(url) {
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
        return ws.origins.has(url.origin) || (ws.resourceOrigins.has(url.origin) &&
          passiveResources.has(type) && ['GET', 'HEAD'].includes(req.method()));
      }
      async function deny(url, reason) {
        record(page, url.origin, type, reason);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
          if (type === 'document') rememberBlock(ws, url.origin, 'navigation', type, reason);
          else if (passiveResources.has(type) && ['GET', 'HEAD'].includes(req.method()))
            rememberBlock(ws, url.origin, 'resource', type, reason);
        }
        await route.abort('blockedbyclient');
      }
      const url = new URL(req.url());
      if (!allowed(url)) return await deny(url, 'origin_denied');
      const passiveOnly = !ws.origins.has(url.origin);
      const options = { maxRedirects: 0, timeout: 12000 };
      if (passiveOnly) {
        // An approved stylesheet or image never inherits the profile's cookies or authorization.
        const anonymous = await getAnonymousContext();
        const headers = Object.fromEntries(Object.entries(req.headers()).filter(([key]) => ['accept','range'].includes(key)));
        response = await anonymous.fetch(url.href, {...options,method:req.method(),headers});
      } else response = await route.fetch(options);
      // An attachment requested while the page was managed must not become a
      // personal download if its headers arrive after the workspace ends.
      if ((released || ws.finishing || ws.mode === 'closed') &&
          /^attachment(?:;|$)/i.test(response.headers()['content-disposition']?.trim() || ''))
        return await route.abort('aborted');
      const location = response.headers().location;
      if (location && response.status() >= 300 && response.status() < 400) {
        const next = new URL(location, url);
        if (!allowed(next)) return await deny(next, 'redirect_origin_denied');
      }
      if (passiveOnly) {
        const headers = response.headers();
        delete headers['set-cookie'];
        await route.fulfill({response,headers});
      } else if (type === 'document') {
        const headers = response.headers();
        const sandbox = "sandbox allow-same-origin allow-scripts allow-forms allow-downloads allow-modals allow-pointer-lock " +
          "allow-presentation allow-orientation-lock allow-storage-access-by-user-activation; worker-src 'none'";
        headers['content-security-policy'] = [headers['content-security-policy'], sandbox].filter(Boolean).join(', ');
        await route.fulfill({ response, headers });
      } else await route.fulfill({ response });
    } catch { await route.abort().catch(() => {}); }
    finally { await response?.dispose().catch(() => {}); }
  }
  await target.route('**/*', httpRoute);
  await target.routeWebSocket('**/*', route => {
    if (released) return route.connectToServer();
    const url = new URL(route.url());
    if (!ws.finishing && ws.mode !== 'closed' && !url.username && !url.password &&
        ['ws:', 'wss:'].includes(url.protocol)) {
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
      if (ws.origins.has(url.origin)) return route.connectToServer();
    }
    return route.close();
  });
  return async () => {
    released = true;
    await target.unroute('**/*', httpRoute);
    await anonymousContextPromise?.catch(() => {});
    await anonymousContext?.dispose().catch(() => {});
    anonymousContext = undefined;
  };
}
