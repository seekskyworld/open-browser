import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('studio tracks external work, groups by state and keeps the chosen workspace and page', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ob-studio-'));
  const original = process.env.OPEN_BROWSER_STATE_DIR;
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const site = createServer(async (req, res) => {
    if (req.url === '/second') {
      entered.resolve();
      await gate.promise;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>fixture</title><main>独立工作区</main>');
  });
  let app;
  let opening;
  try {
    process.env.OPEN_BROWSER_STATE_DIR = stateDir;
    const { startApplication } = await import('../service.mjs');
    const { OpenBrowserClient } = await import('../sdk.mjs');
    app = await startApplication({ headless: true, mode: 'web' });
    const api = new OpenBrowserClient();
    const ui = app.page;
    ui.setDefaultTimeout(7000);
    await ui.getByText('本机服务已连接').waitFor();
    const groupRow = (group, id) => ui.getByRole('group', { name: group, exact: true })
      .locator('[data-workspace-id="' + id + '"]');

    const a = await api.createWorkspace({ name: '有待补充的任务' });
    const first = await api.openPage(a.workspaceId, app.studio.demoUrl);
    await groupRow('待命', a.workspaceId).click();
    await ui.locator('#pages').selectOption(first.pageId);
    const secondA = await api.openPage(a.workspaceId, app.studio.demoUrl);
    await ui.locator('#pages option[value="' + secondA.pageId + '"]').waitFor({ state: 'attached' });
    assert.equal(await ui.locator('#pages').inputValue(), first.pageId);

    site.listen(0, '127.0.0.1');
    await once(site, 'listening');
    const b = await api.createWorkspace({ name: '并发任务' });
    const url = 'http://127.0.0.1:' + site.address().port;
    const firstB = await api.openPage(b.workspaceId, url);
    opening = api.openPage(b.workspaceId, url + '/second');
    await Promise.race([entered.promise, opening]);
    await ui.bringToFront();
    await groupRow('Agent 运行', b.workspaceId).waitFor();
    assert.equal(await ui.locator('#workspace-name').innerText(), a.name);
    assert.equal(await ui.locator('#pages').inputValue(), first.pageId);
    gate.resolve();
    await opening;
    await groupRow('待命', b.workspaceId).waitFor();

    const before = await api.observe(first);
    const field = before.elements.find(el => el.name === '密码');
    assert.ok(field);
    const { operationId } = await api.act(first, {
      operationId: 'missing-local-password', documentId: before.documentId,
      controlGeneration: before.controlGeneration,
      actions: [{ kind: 'fillCredential', ref: field.ref, credentialRef: 'account.password' }],
    });
    await groupRow('待处理', a.workspaceId).waitFor();
    await ui.locator('#credential-view').waitFor();
    assert.match(await ui.locator('#credential-ref').innerText(), /account\.password/);
    assert.match(await ui.locator('#credential-origin').innerText(), /127\.0\.0\.1/);
    assert.equal((await api.getOperation(a.workspaceId, operationId)).error, 'credential_required');
    await groupRow('待命', b.workspaceId).click();
    assert.equal(await ui.locator('#credential-view').isVisible(), false);
    await groupRow('待处理', a.workspaceId).click();
    await ui.locator('#password').fill('local-workspace-test-only');
    await ui.getByRole('button', { name: '绑定凭据', exact: true }).click();
    await groupRow('待命', a.workspaceId).waitFor();
    assert.equal(await ui.locator('#credential-view').isVisible(), false);

    await api.handOff(a.workspaceId);
    await ui.bringToFront();
    await groupRow('人工接管', a.workspaceId).waitFor();
    await assert.rejects(api.observe(first));
    assert.match((await api.observe(firstB)).text, /独立工作区/);
    await ui.getByRole('button', { name: '交回 Agent' }).click();
    await groupRow('待命', a.workspaceId).waitFor();
    const after = await api.observe(first);
    assert.equal(after.pageId, before.pageId);
    assert.notEqual(after.controlGeneration, before.controlGeneration);
    assert.equal(await ui.locator('#workspace-name').innerText(), a.name);
    await api.closeWorkspace(b.workspaceId);
    await groupRow('待命', b.workspaceId).waitFor({ state: 'detached' });
    assert.equal(await ui.locator('#workspace-name').innerText(), a.name);
  } finally {
    gate.resolve();
    await opening?.catch(() => {});
    await app?.close();
    if (site.listening) {
      site.closeAllConnections();
      await new Promise(resolve => site.close(resolve));
    }
    if (original === undefined) delete process.env.OPEN_BROWSER_STATE_DIR;
    else process.env.OPEN_BROWSER_STATE_DIR = original;
    await rm(stateDir, { recursive: true, force: true });
  }
});
