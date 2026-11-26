import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function site(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    origin: 'http://127.0.0.1:' + server.address().port,
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('read-only observation contract across supported transports', async t => {
  const previousState = process.env.OPEN_BROWSER_STATE_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), 'open-browser-observe-contract-'));
  process.env.OPEN_BROWSER_STATE_DIR = dir;
  t.after(async () => {
    if (previousState === undefined) delete process.env.OPEN_BROWSER_STATE_DIR;
    else process.env.OPEN_BROWSER_STATE_DIR = previousState;
    await rm(dir, { recursive: true, force: true });
  });
  // paths.mjs captures the profile at import. Import its consumers only after isolation.
  const { startObserveExperiment } = await import('./observe-service.mjs');
  const { adminTokenPath, socketPath, tokenPath } = await import('../paths.mjs');
  assert.ok(adminTokenPath.startsWith(dir + path.sep));
  const { OpenBrowserClient, localRequest } = await import('../sdk.mjs');
  let forbiddenHits = 0;
  const forbidden = await site((_req, res) => {
    forbiddenHits++;
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>private-frame-marker</p>');
  });
  t.after(() => forbidden.close());
  const allowed = await site((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/frame') return res.end('<p>visible-frame-marker</p>');
    res.end('<h1>allowed-marker</h1><button>Save</button><label>Account<input value="hidden-form-value"></label>' +
      '<iframe src="/frame"></iframe><iframe src="' + forbidden.origin + '/private"></iframe>');
  });
  t.after(() => allowed.close());
  for (const mode of ['playwright', 'direct', 'rust']) {
    await t.test(mode, async () => {
      const app = await startObserveExperiment(mode);
      try {
        const admin = (method, params) => localRequest(socketPath, adminTokenPath, '/v1/admin', method, params);
        const paired = await admin('pair', { name: 'read-only-' + mode });
        const readerKey = path.join(dir, mode + '.key');
        await writeFile(readerKey, paired.token, { mode: 0o600, flag: 'wx' });
        const reader = new OpenBrowserClient({ socketPath, tokenPath: readerKey });
        const owner = new OpenBrowserClient({ socketPath, tokenPath });
        const { workspaceId } = await owner.createWorkspace({ name: '测试任务', allowedOrigins: [allowed.origin] });
        const handle = await owner.openPage(workspaceId, allowed.origin + '/');
        const authoritative = await owner.observe(handle);
        await assert.rejects(reader.observe(handle), { code: 'workspace_not_found' });
        await admin('grant', { workspaceId, principalId: paired.principalId, permission: 'read' });
        const plain = await reader.observe(handle);
        assert.equal(plain.frames, undefined);
        assert.deepEqual(plain.elements, [{ role: 'button', name: 'Save' }, { role: 'textbox', name: 'Account' }]);
        assert.match(plain.text, /allowed-marker/);
        assert.doesNotMatch(JSON.stringify(plain), /hidden-form-value|private-frame-marker/);
        const framed = await reader.observe({ ...handle, includeFrames: true });
        assert.deepEqual(framed.frames, [{ origin: allowed.origin, text: 'visible-frame-marker' }]);
        await assert.rejects(owner.openPage(workspaceId, forbidden.origin), { code: 'origin_denied' });
        const operation = { documentId: authoritative.documentId, controlGeneration: authoritative.controlGeneration,
          operationId: 'save-' + mode, actions: [{ kind: 'click', ref: authoritative.elements[0].ref }] };
        await assert.rejects(reader.act(handle, operation), { code: 'forbidden' });
        await assert.rejects(reader.handOff(workspaceId), { code: 'forbidden' });
        await assert.rejects(reader.closeWorkspace(workspaceId), { code: 'forbidden' });
        // The reader's observations must leave the owner's element references usable.
        await owner.act(handle, operation);
        await owner.observe(handle);
        assert.equal((await owner.getOperation(workspaceId, operation.operationId)).state, 'completed');
        await owner.handOff(workspaceId);
        await assert.rejects(reader.observe(handle), { code: 'workspace_under_user_control' });
        await admin('revoke', { workspaceId, principalId: paired.principalId });
        await assert.rejects(reader.observe(handle), { code: 'workspace_not_found' });
        assert.equal(forbiddenHits, 0);
      } finally { await app.close(); }
    });
  }
});

test('discard a completed observer reply if its target changed in flight', async t => {
  const { BrowserService } = await import('../engine-service.mjs');
  const { launchBrowser } = await import('../control.mjs');
  const local = await site((_req, res) =>
    res.writeHead(200, { 'content-type': 'text/html' }).end('<p>sample</p>'));
  t.after(() => local.close());
  const browser = await launchBrowser();
  t.after(() => browser.close());
  for (const change of ['handoff', 'navigation', 'unauthorized navigation', 'page closure']) {
    await t.test(change, async () => {
      const started = Promise.withResolvers();
      const ready = Promise.withResolvers();
      const engine = new BrowserService(browser, { readOnlyObserver: async () => {
        started.resolve();
        await ready.promise;
        return { text: 'stale-content-must-be-discarded', details: [] };
      } });
      const call = (method, params) => engine.call(method, params, 'owner');
      try {
        const { workspaceId } = await call('createWorkspace', { name: '测试任务', allowedOrigins: [local.origin] });
        const handle = await call('openPage', { workspaceId, url: local.origin });
        const tab = engine.workspaces.get(workspaceId).pages.get(handle.pageId);
        const pending = call('observeReadOnly', handle);
        await started.promise;
        let transfer;
        if (change === 'handoff') transfer = call('takeControl', handle);
        if (change === 'navigation') await tab.page.goto(local.origin + '/next');
        if (change === 'unauthorized navigation') await tab.page.goto('about:blank');
        if (change === 'page closure') await call('closePage', handle);
        ready.resolve();
        await assert.rejects(pending, error =>
          ['workspace_under_user_control', 'stale_observation', 'origin_denied', 'page_not_found'].includes(error.code));
        await transfer;
      } finally {
        ready.resolve();
        await engine.shutdown();
      }
    });
  }
});
