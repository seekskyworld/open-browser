import { limits } from './api-contract.mjs';
import path from 'node:path';
import { AccessRegistry } from './access-registry.mjs';
import http from 'node:http';
import net from 'node:net';
import { createInterface } from 'node:readline';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { launchBrowser } from './control.mjs';
import { agentMethods } from './sdk.mjs';
import { BrowserService } from './engine-service.mjs';
import { socketPath, stateDir, tokenPath, adminTokenPath } from './paths.mjs';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function bind(server) {
  try { await listen(server); }
  catch (error) {
    if (error.code !== 'EADDRINUSE' || process.platform === 'win32') throw error;
    const active = await new Promise((resolve, reject) => {
      const probe = net.connect(socketPath);
      probe.once('connect', () => { probe.end(); resolve(true); });
      probe.once('error', err => err.code === 'ECONNREFUSED' ? resolve(false) : reject(err));
    });
    if (active || !(await lstat(socketPath)).isSocket()) throw error;
    await unlink(socketPath);
    await listen(server);
  }
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
}

function reply(res, status, body) {
  if (res.destroyed) return;
  const data = JSON.stringify(body);
  if (Buffer.byteLength(data) > limits.responseBytes)
    return reply(res, 413, {error:{code:'response_too_large',message:'Reduce page or history limit'}});
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(data);
}

function validToken(header, expected) {
  const actual = Buffer.from(header || '');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readRequest(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limits.requestBytes) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function errorCode(error) {
  return typeof error?.code === 'string' && /^[a-z_]{1,64}$/i.test(error.code)
    ? error.code : 'operation_failed';
}

export async function startApplication({ headless = false, mode = 'service', onShow, onBar,
  launchServiceBrowser = launchBrowser, readOnlyObserver, chromiumNetLog } = {}) {
  if (!['web', 'native', 'service', 'chromium'].includes(mode)) throw new Error('invalid_mode');
  if (process.env.OPEN_BROWSER_AUTO_INSTALL_SKILLS !== '0') {
    try {
      const { installAgentSkillLinks } = await import('./skill-links.mjs');
      const result = await installAgentSkillLinks();
      if (process.env.OPEN_BROWSER_SKILLS_VERBOSE === '1') console.error(JSON.stringify({ skillLinks: result }));
    } catch (error) {
      if (process.env.OPEN_BROWSER_SKILLS_VERBOSE === '1') console.error(JSON.stringify({ skillLinksError: error.message }));
    }
  }
  await mkdir(stateDir, { mode: 0o700, recursive: true });
  if (process.platform !== 'win32') await chmod(stateDir, 0o700);
  const token = randomBytes(32).toString('hex');
  const authorization = Buffer.from('Bearer ' + token);
  const adminToken = randomBytes(32).toString('hex');
  let registry;
  let browser, engine, studio, uiContext, page, shell, sharedContext;
  let ready = false;
  let closing;
  let showing;

  async function openControlWindow() {
    if (shell) return shell.show();
    if (mode === 'native') { onShow?.(); return; }
    if (mode !== 'web') throw Object.assign(new Error('desktop_unavailable'), { code: 'desktop_unavailable' });
    if (showing) return showing;
    showing = (async () => {
      if (!page || page.isClosed()) {
        page = await uiContext.newPage();
        await page.goto(studio.issueUrl(), { waitUntil: 'domcontentloaded' });
      }
      await page.bringToFront();
      return page;
    })();
    try { return await showing; }
    finally { showing = undefined; }
  }

  const server = http.createServer({ requestTimeout: 20_000, headersTimeout: 10_000 }, async (req, res) => {
    const fail = (status, code, message) => reply(res, status, { error: { code, message } });
    const admin = req.url === '/v1/admin';
    if ((!admin && req.url !== '/v1/call') || req.method !== 'POST') return fail(404, 'not_found', 'Unknown endpoint');
    const header = req.headers.authorization;
    const identity = () => validToken(header, authorization) ? 'local' :
      (header?.startsWith('Bearer ') && registry?.principal(header.slice(7)));
    if (req.headers.origin || !(admin ? validToken(header, Buffer.from('Bearer ' + adminToken)) : identity()))
      return fail(403, 'forbidden', 'Local client authorization required');
    if (!ready) return fail(503, 'not_ready', 'Service is starting or stopping');
    let input;
    try { input = await readRequest(req); }
    catch { return fail(400, 'invalid_request', 'Invalid JSON request or size limit exceeded'); }
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return fail(400, 'invalid_request', 'Expected request object');
    const { method, params = {} } = input;
    if (!params || typeof params !== 'object' || Array.isArray(params))
      return fail(400, 'invalid_request', 'Expected params object');
    try {
      if (admin) return reply(res, 200, {result: await registry.admin(engine, method, params)});
      const client = identity();
      if (!client) return fail(403,'forbidden','Client revoked');
      if (method === 'desktop.open' && client === 'local') { await openControlWindow(); return reply(res, 200, { result: true }); }
      if (!agentMethods.includes(method)) return fail(403, 'forbidden', 'Method unavailable to this client');
      const result = await registry.call(engine, client, method, params);
      reply(res, 200, { result: result ?? null });
    } catch (error) {
      const code = errorCode(error);
      fail(400, code, code.replaceAll('_', ' '));
    }
  });

  await bind(server);
  let resolveClosed;
  const closed = new Promise(resolve => { resolveClosed = resolve; });
  function close() {
    if (closing) return closing;
    ready = false;
    closing = (async () => {
      shell?.stop();
      // Remove this instance's token before releasing the socket for the next instance.
      if ((await readFile(tokenPath, 'utf8').catch(() => '')).trim() === token)
        await unlink(tokenPath).catch(() => {});
      if ((await readFile(adminTokenPath, 'utf8').catch(() => '')).trim() === adminToken) await unlink(adminTokenPath).catch(() => {});
      const serverClosed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      try {
        if (studio) await studio.close();
        if (engine) await engine.shutdown();
      } finally {
        await sharedContext?.close().catch(() => {});
        await browser?.close().catch(() => {});
        await serverClosed;
        registry?.db.close();
        resolveClosed();
      }
    })();
    return closing;
  }
  try {
    registry = new AccessRegistry(path.join(stateDir, 'open-browser-access.sqlite'));
    if (mode === 'chromium') {
      const { launchChromiumShell } = await import('./chromium-shell.mjs');
      const { chromiumHost } = await import('./chromium-host.mjs');
      sharedContext = await launchChromiumShell({ headless, netLogPath:chromiumNetLog });
      try { shell = await chromiumHost(sharedContext); }
      catch (error) {
        if (error.code !== 'extension_reload') throw error;
        await sharedContext.close();
        sharedContext = await launchChromiumShell({ headless, netLogPath:chromiumNetLog });
        shell = await chromiumHost(sharedContext);
      }
      browser = sharedContext.browser();
    } else {
      browser = await launchServiceBrowser({ headless: mode === 'native' || headless });
    }
    engine = new BrowserService(browser, { concurrency: 4, sharedContext, readOnlyObserver, journalPath: path.join(stateDir, 'open-browser-receipts.sqlite'), releaseTab: shell?.releaseTab, groupTab: shell?.groupTab, onActivity: shell?.onActivity,
      onActionTarget: shell?.onActionTarget });
    const call = async (method, params = {}) => {
      if (method === 'createWorkspace') return registry.call(engine, 'local', method, params);
      if (method === 'listWorkspaces') {
        const owners = new Set([...engine.workspaces.values()].map(ws => ws.owner));
        return (await Promise.all([...owners].map(owner => engine.call(method, params, owner)))).flat();
      }
      return engine.call(method === 'finishWorkspace' ? 'hostFinishWorkspace' : method, params, registry.owner(params.workspaceId) || 'local', 'desktop');
    };
    if (mode === 'web') {
      const { startStudio } = await import('./studio/index.mjs');
      studio = await startStudio({ call });
      uiContext = await browser.newContext({ viewport: null, acceptDownloads: false, serviceWorkers: 'block' });
      const uiOrigin = new URL(studio.url).origin;
      await uiContext.route('**/*', route => {
        return new URL(route.request().url()).origin === uiOrigin ? route.continue() : route.abort();
      });
      await openControlWindow();
    }
    async function hostCall(method, params = {}) {
      if (!ready) throw Object.assign(new Error('not_ready'), { code: 'not_ready' });
      switch (method) {
        case 'listWorkspaces': return call(method, params);
        case 'listAgentHistory': return registry.listHistory(engine, 'local', params);
        case 'getWorkspace': return call(method, params);
        default: return call(method, params);
      }
    }
    for (const [file,value] of [[tokenPath,token],[adminTokenPath,adminToken]]) {
      const temporary = file + '.' + process.pid;
      await writeFile(temporary, value + '\n', { mode: 0o600, flag: 'wx' });
      await rename(temporary, file);
    }
    ready = true;
    shell?.start(hostCall, onBar);
    browser.once('disconnected', () => { void close(); });
    return { close, closed, openControlWindow, studio, page, hostCall, sharedContext,
      clickBar: frame => shell?.clickBar(frame, hostCall) };
  } catch (error) {
    await close();
    throw error;
  }
}

async function main() {
  let active;
  process.on('SIGUSR2', () => { void active?.openControlWindow().catch(() => {}); });
  const native = process.argv.includes('--native-host');
  const desktopBar = !native && process.argv.includes('--chromium') && process.argv.includes('--desktop-bar');
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  const app = await startApplication({ headless: process.argv.includes('--headless'),
    mode: native ? 'native' : process.argv.includes('--chromium') ? 'chromium' : 'service',
    onBar: desktopBar ? bar => send({ event: 'desktop.bar', bar }) : undefined,
    onShow: () => send({ event: 'desktop.open' }) });
  active = app;
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close(); });
  if (native || desktopBar) {
    const channel = createInterface({ input: process.stdin, crlfDelay: Infinity });
    channel.on('line', async line => {
      if (desktopBar) {
        try {
          if (Buffer.byteLength(line) > 4096) return;
          const frame = JSON.parse(line);
          if (frame?.event === 'desktop.bar.click') await app.clickBar(frame);
        } catch { /* An obsolete click has no effect on control ownership. */ }
        return;
      }
      let id = null;
      try {
        if (Buffer.byteLength(line) > 256 * 1024) throw new Error();
        const frame = JSON.parse(line);
        if (!frame || !(typeof frame.id === 'string' || Number.isSafeInteger(frame.id))
            || typeof frame.method !== 'string' || !frame.method ||
            (frame.params !== undefined && (!frame.params || typeof frame.params !== 'object' || Array.isArray(frame.params))))
          throw new Error();
        id = frame.id;
        const result = await app.hostCall(frame.method, frame.params);
        send({ id, result: result ?? null });
      } catch (error) { send({ id, error: id === null ? 'invalid_request' : errorCode(error) }); }
    });
    channel.once('close', () => { void app.close(); });
    app.closed.then(() => { channel.close(); process.stdin.unref?.(); });
    send({ ready: true });
  } else console.log('open-browser ready');
  await app.closed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.code === 'EADDRINUSE' ? 'open-browser is already running.' : error.message);
    process.exitCode = 1;
  });
}
