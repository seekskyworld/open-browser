import { readFile } from 'node:fs/promises';
import { startDemo, randomToken, reply, json, readBody, serve } from './demo-site.mjs';

const methods = new Set(['createWorkspace', 'listWorkspaces', 'getWorkspace', 'openPage', 'observe', 'previewPage', 'showPage', 'act', 'getOperation', 'cancelOperation', 'closeWorkspace', 'setCredential', 'resolveCredential', 'takeControl', 'returnToAgent']);
export async function startStudio({ call }) {
  const resources = {};
  for (const [route, name, type] of [
    ['/open-browser-icon.png', '../browser-extension/icons/open-browser-48.png', 'image/png'],
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/studio.css', 'studio.css', 'text/css'],
    ['/studio.js', 'studio.js', 'text/javascript; charset=utf-8'],
  ]) resources[route] = [await readFile(new URL(name, import.meta.url)), type];
  const demo = await startDemo();
  const access = randomToken();
  let pairingKey;
  const demoUrl = demo.origin + '/login';
  let site;
  try {
    site = await serve(async (req, res, origin) => {
      if (req.method === 'GET' && Object.hasOwn(resources, req.url)) {
        const [content, type] = resources[req.url];
        return reply(res, 200, content, type);
      }
      if (req.method !== 'POST' || req.headers.origin !== origin ||
          req.headers['content-type'] !== 'application/json') return reply(res, 403, 'Forbidden');
      if (req.url === '/pair') {
        const data = JSON.parse(await readBody(req));
        if (!pairingKey || data.key !== pairingKey) return json(res, 403, { error: 'pairing_failed' });
        pairingKey = undefined;
        return json(res, 200, { access });
      }
      if (req.headers.authorization !== 'Bearer ' + access) return json(res, 403, { error: 'unauthorized' });
      if (req.url === '/config') return json(res, 200, { demoUrl, username: demo.demoAccount.username });
      if (req.url === '/demo-password') return json(res, 200, { password: demo.demoAccount.password });
      if (req.url === '/call') {
        const { method, params = {} } = JSON.parse(await readBody(req));
        if (!methods.has(method)) return json(res, 400, { error: 'unknown_method' });
        try { return json(res, 200, { result: await call(method, params) }); }
        catch (error) {
          return json(res, 400, { error: /^[a-z0-9_]+$/i.test(error.code || '') ? error.code : 'request_failed' });
        }
      }
      return reply(res, 404, 'Not found');
    });
  } catch (error) {
    await demo.close();
    throw error;
  }
  function issueUrl() {
    pairingKey = randomToken();
    return site.origin + '/#' + pairingKey;
  }
  return {
    url: issueUrl(), demoUrl, demoAccount: demo.demoAccount, issueUrl,
    close: () => Promise.all([site.close(), demo.close()]),
  };
}
