import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { launchBrowser } from './control.mjs';
import { BrowserService } from './engine-service.mjs';

test('two visible background workspaces leave the foreground editor focused', {
  skip: process.env.OPEN_BROWSER_HEADED_TESTS !== '1',
}, async t => {
  const site = createServer((req, res) => {
    const marker = req.url === '/a' ? 'A' : 'B';
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      '<label>Task<input></label><button onclick="document.querySelector(\'output\').textContent=' +
      "'" + marker + ":'" + '+document.querySelector(\'input\').value">Save</button><output></output>');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const url = 'http://127.0.0.1:' + site.address().port;
  const browser = await launchBrowser({ headless: false });
  const service = new BrowserService(browser);
  t.after(async () => {
    await service.shutdown();
    await browser.close();
    site.closeAllConnections();
    await new Promise(resolve => site.close(resolve));
  });
  const personal = await browser.newContext();
  const editor = await personal.newPage();
  const probe = await personal.newCDPSession(editor);
  // Playwright normally emulates focus. Observe the renderer's real state.
  await probe.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await editor.setContent('<textarea id="draft">private draft</textarea>');
  await editor.bringToFront();
  await editor.locator('#draft').focus();
  await editor.evaluate(() => {
    window.focusEvents = [];
    window.addEventListener('blur', () => window.focusEvents.push('blur'));
    document.addEventListener('visibilitychange', () => window.focusEvents.push(document.visibilityState));
  });
  const state = () => editor.evaluate(() => ({
    focused: document.hasFocus(), visible: document.visibilityState, active: document.activeElement.id,
    text: document.querySelector('#draft').value, events: window.focusEvents,
  }));
  const initial = await state();
  assert.deepEqual(initial, { focused: true, visible: 'visible', active: 'draft', text: 'private draft', events: [] });
  await Promise.all(['A', 'B'].map(async marker => {
    const call = (method, args) => service.call(method, args, marker);
    const { workspaceId } = await call('createWorkspace', { name: '测试任务' });
    const page = await call('openPage', { workspaceId, url: url + '/' + marker.toLowerCase() });
    const observation = await call('observe', page);
    const ref = role => observation.elements.find(el => el.role === role).ref;
    await call('act', { ...page, operationId: 'input', documentId: observation.documentId,
      controlGeneration: observation.controlGeneration, actions: [
        { kind: 'fill', ref: ref('textbox'), value: 'work-' + marker },
        { kind: 'click', ref: ref('button') },
      ] });
    // A read in the same workspace is ordered after its preceding input.
    assert.match((await call('observe', page)).text, new RegExp(marker + ':work-' + marker));
  }));
  assert.deepEqual(await state(), initial);
});

test('service keeps login, ownership, receipts and control generation scoped to a workspace', async t => {
  let submits = 0;
  const server = createServer(async (req, res) => {
    if (req.url === '/auth' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      submits++;
      if (new URLSearchParams(body).get('pw') === 'local-test-only') {
        res.writeHead(303, { location: '/account', 'set-cookie': 'session=verified; HttpOnly; SameSite=Strict' }).end();
      } else res.writeHead(403).end('bad login');
      return;
    }
    if (req.url === '/account' && req.headers.cookie === 'session=verified') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<main>account verified</main>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      '<form method="POST" action="/auth"><label>Password<input type="password" name="pw"></label><button>Submit</button></form>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser();
  const targets = [];
  const service = new BrowserService(browser, { concurrency: 2, onActionTarget(target) {
    targets.push(target);
    return new Promise(() => {}); // A stalled renderer must never delay the login.
  } });
  t.after(async () => {
    await service.shutdown();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const call = (method, params) => service.call(method, params, 'sdk');
  async function waitFor(workspaceId, operationId) {
    for (let n = 0; n < 250; n++) {
      const receipt = await call('getOperation', { workspaceId, operationId });
      if (!['running', 'queued'].includes(receipt.state)) return receipt;
      await sleep(25);
    }
    assert.fail('operation timed out');
  }
  const { workspaceId } = await call('createWorkspace', { name: '测试任务', allowedOrigins: [origin] });
  const page = await call('openPage', { workspaceId, url: origin });
  const state = await call('observe', page);
  assert.equal(state.elements.find(el => el.role === 'textbox').name, 'Password');
  const password = state.elements.find(el => el.role === 'textbox').ref;
  const submit = state.elements.find(el => el.role === 'button').ref;
  const readOnly = await call('observeReadOnly', page);
  assert.equal(readOnly.documentId, state.documentId);
  assert.deepEqual(readOnly.elements, state.elements.map(({role,name}) => ({role,name})));
  // A person can inspect this page while an agent holds the observed references.
  const preview = await call('previewPage', page);
  assert.match(preview.text, /Password/);
  assert.equal(preview.documentId, state.documentId);
  assert.ok(!('elements' in preview));
  const request = { ...page, operationId: 'first', documentId: state.documentId,
    controlGeneration: state.controlGeneration, actions: [
      { kind: 'fillCredential', ref: password, credentialRef: 'site-password' },
      { kind: 'click', ref: submit },
    ] };
  await call('act', request);
  assert.equal((await waitFor(workspaceId, 'first')).error, 'credential_required');
  assert.equal(targets.length, 0);
  assert.equal(submits, 0);
  const pendingInfo = await call('getWorkspace', { workspaceId });
  assert.equal(pendingInfo.activity.phase, 'needs_credential');
  assert.deepEqual(pendingInfo.activity.credentialRequest, {
    origin, pageId: page.pageId, credentialRef: 'site-password', operationId: 'first',
    documentId: state.documentId, controlGeneration: state.controlGeneration,
  });
  assert.equal((await call('listWorkspaces', {}))[0].activity.credentialRequest, null);
  await call('setCredential', { workspaceId, origin, credentialRef: 'other', value: 'unrelated-secret' });
  assert.equal((await call('getWorkspace', { workspaceId })).activity.needsCredential, true);
  await call('setCredential', { workspaceId, origin, credentialRef: 'site-password', value: 'local-test-only' });
  assert.equal((await call('getWorkspace', { workspaceId })).activity.needsCredential, false);
  const retry = { ...request, operationId: 'next' };
  await call('act', retry);
  assert.equal((await waitFor(workspaceId, 'next')).state, 'completed');
  assert.ok(targets.length > 0);
  for (const target of targets) {
    assert.deepEqual(Object.keys(target).sort(), ['workspaceId','pageId','documentId','controlGeneration','x','y','origin'].sort());
    assert.equal(target.workspaceId, workspaceId);
    assert.equal(target.pageId, page.pageId);
    assert.equal(target.documentId, state.documentId);
    assert.equal(target.controlGeneration, state.controlGeneration);
    assert.equal(target.origin, origin);
    assert.ok(target.x > 0 && target.y > 0);
  }
  const completed = (await call('getWorkspace', { workspaceId })).activity;
  assert.equal(completed.phase, 'completed');
  assert.deepEqual(completed.recent, { kind: 'act', state: 'completed', phase: 'completed', completedSteps: 2, totalSteps: 2, stepKind: 'click' });
  assert.doesNotMatch(JSON.stringify(completed), /unrelated-secret|local-test-only|site-password|\/auth/);
  assert.equal((await call('act', retry)).state, 'completed');
  assert.match((await call('observe', page)).text, /account verified/);
  assert.equal(submits, 1);
  await assert.rejects(service.call('observe', page, 'other'), { code: 'workspace_not_found' });
  const second = await call('createWorkspace', { name: '测试任务' });
  const secondPage = await call('openPage', { workspaceId: second.workspaceId, url: origin + '/account' });
  assert.doesNotMatch((await call('observe', secondPage)).text, /account verified/);
  await assert.rejects(call('openPage', { workspaceId, url: 'https://example.org/' }), { code: 'origin_denied' });
  await call('handOff', page);
  assert.deepEqual(await call('showPage', page), page);
  await assert.rejects(call('observe', page), { code: 'workspace_under_user_control' });
  await call('observe', secondPage);
  await call('returnToAgent', { workspaceId });
  await assert.rejects(call('showPage', page), { code: 'not_in_human_control' });
  await assert.rejects(call('act', { ...retry, operationId: 'old' }), { code: 'stale_control' });
  const after = await call('observe', page);
  assert.match(after.text, /account verified/);
  assert.notEqual(after.controlGeneration, state.controlGeneration);
});

test('activity exposes queued and running work across clients and survives failed navigation', async t => {
  let markStarted, release;
  const started = new Promise(resolve => { markStarted = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const server = createServer(async (req, res) => {
    if (req.url === '/slow') {
      markStarted();
      await paused;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<main>page text should not be in activity</main>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser();
  const service = new BrowserService(browser, { concurrency: 1 });
  t.after(async () => {
    release();
    await service.shutdown();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const first = await service.call('createWorkspace', { name: '测试任务' }, 'first');
  const second = await service.call('createWorkspace', { name: '测试任务' }, 'second');
  assert.equal(first.activity.phase, 'idle');
  const opening = service.call('openPage', { workspaceId: first.workspaceId, url: url + '/slow' }, 'first');
  await started;
  const waiting = service.call('openPage', { workspaceId: second.workspaceId, url }, 'second');
  const running = (await service.call('listWorkspaces', {}, 'first'))[0].activity;
  assert.equal(running.phase, 'running');
  assert.equal(running.current.kind, 'openPage');
  assert.equal(running.current.phase, 'running');
  assert.equal(running.current.completedSteps, 0);
  const queued = (await service.call('listWorkspaces', {}, 'second'))[0].activity;
  assert.equal(queued.phase, 'queued');
  assert.equal(queued.queued, 1);
  release();
  await Promise.all([opening, waiting]);
  const finished = (await service.call('listWorkspaces', {}, 'first'))[0].activity;
  assert.equal(finished.current, null);
  assert.equal(finished.recent.completedSteps, 1);
  assert.equal(finished.recent.phase, 'completed');
  await assert.rejects(service.call('openPage', { workspaceId: first.workspaceId, url: 'file:///private' }, 'first'), { code: 'invalid_url' });
  const failed = (await service.call('getWorkspace', { workspaceId: first.workspaceId }, 'first')).activity;
  assert.equal(failed.phase, 'failed');
  assert.equal(failed.recent.error, 'invalid_url');
  assert.doesNotMatch(JSON.stringify(failed), /private|page text|\/slow/);
});

test('navigation shares one global budget and blocks unapproved redirect and subresource origins', async t => {
  let externalHits = 0;
  const outside = createServer((_, res) => { externalHits++; res.end('unexpected'); });
  outside.listen(0, '127.0.0.1');
  await once(outside, 'listening');
  const otherOrigin = 'http://127.0.0.1:' + outside.address().port;
  let active = 0;
  let peak = 0;
  const site = createServer(async (req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(307, { location: otherOrigin }).end();
      return;
    }
    if (req.url === '/') {
      peak = Math.max(peak, ++active);
      await sleep(120);
      active--;
    }
    res.writeHead(200, { 'content-type': 'text/html' }).end('<img src="' + otherOrigin + '/pixel">');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const url = 'http://127.0.0.1:' + site.address().port;
  const browser = await launchBrowser();
  const service = new BrowserService(browser, { concurrency: 2 });
  t.after(async () => {
    await service.shutdown();
    await browser.close();
    await Promise.all([site, outside].map(server => {
      server.closeAllConnections();
      return new Promise(resolve => server.close(resolve));
    }));
  });
  const workspaces = await Promise.all(Array.from({ length: 4 }, (_, i) =>
    service.call('createWorkspace', { name: '测试任务' }, String(i))));
  await Promise.all(workspaces.map((ws, i) =>
    service.call('openPage', { workspaceId: ws.workspaceId, url }, String(i))));
  assert.equal(peak, 2);
  await assert.rejects(service.call('openPage', {
    workspaceId: workspaces[0].workspaceId, url: url + '/redirect',
  }, '0'), { code: 'navigation_failed' });
  assert.equal(externalHits, 0);
  // Start the short expiry timer only for the cases that exercise eviction.
  // Slow Chromium startup and navigation on a loaded machine are unrelated.
  const expiring = new BrowserService(browser, { idleTimeoutMs: 250 });
  try {
    const user = await expiring.call('createWorkspace', { name: '测试任务' }, 'user');
    await expiring.call('takeControl', { workspaceId: user.workspaceId }, 'user');
    await expiring.call('createWorkspace', { name: '测试任务' }, 'idle');
    for (let n = 0; n < 70; n++) {
      if (!(await expiring.call('listWorkspaces', {}, 'idle')).length) break;
      await sleep(70);
    }
    assert.deepEqual(await expiring.call('listWorkspaces', {}, 'idle'), []);
    assert.equal((await expiring.call('listWorkspaces', {}, 'user'))[0].mode, 'human');
  } finally { await expiring.shutdown(); }
});

test('desktop frames and queued input are scoped to the current document and handoff', async t => {
  const server = createServer((req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
    req.url.startsWith('/second') ? '<title>第二页</title><input autofocus><output>第二页</output>' :
    '<title>测试标签</title><a style="display:block;width:200px;height:60px" href="/second">Next</a>'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser();
  const service = new BrowserService(browser);
  t.after(async () => {
    await service.shutdown();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const call = (method, params) => service.call(method, params, 'desktop');
  const { workspaceId } = await call('createWorkspace', { name: '测试任务' });
  const handle = await call('openPage', { workspaceId, url: origin + '/?auth=private' });
  const { pages } = await call('getWorkspace', { workspaceId });
  assert.equal(pages[0].title, '测试标签');
  assert.doesNotMatch(JSON.stringify(pages), /auth|private/);
  await call('takeControl', handle);
  const viewport = { ...handle, width: 800, height: 500 };
  const first = call('pageFrame', viewport);
  await assert.rejects(call('pageFrame', viewport), { code: 'frame_busy' });
  const frame = await first;
  const input = (view, event) => call('pageInput', { ...handle, event,
    controlGeneration: view.controlGeneration, documentId: view.documentId });
  await assert.rejects(input(frame, { type: 'text', text: 'valid', extra: true }), { code: 'invalid_input' });
  await assert.rejects(input(frame, { type: 'mouseMove', x: 800, y: 0 }), { code: 'invalid_input' });
  for (const type of ['mouseDown', 'mouseUp']) await input(frame, { type, x: 20, y: 20 });
  async function afterNavigation(previous) {
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const fresh = await call('pageFrame', viewport);
        if (fresh.documentId !== previous.documentId) return fresh;
      } catch (error) { if (error.code !== 'stale_observation') throw error; }
      await sleep(20);
    }
    assert.fail('expected a new Chromium document');
  }
  const next = await afterNavigation(frame);
  assert.equal(next.title, '第二页');
  assert.notEqual(next.documentId, frame.documentId);
  await assert.rejects(input(frame, { type: 'text', text: 'expired' }), { code: 'stale_observation' });
  await input(next, { type: 'keyDown', key: 'Shift' });
  const queuedInput = input(next, { type: 'text', text: 'raced-with-return' });
  const returned = call('returnToAgent', handle);
  await assert.rejects(queuedInput, { code: 'not_in_human_control' });
  assert.equal((await returned).mode, 'agent');
  const newOwner = await call('takeControl', handle);
  const newFrame = await call('pageFrame', viewport);
  assert.equal(newOwner.controlGeneration, newFrame.controlGeneration);
  await assert.rejects(input(next, { type: 'keyDown', key: 'Enter' }), { code: 'stale_control' });
  await input(newFrame, { type: 'keyDown', key: 'Meta' });
  await input(newFrame, { type: 'keyDown', key: '[' });
  const back = await afterNavigation(newFrame);
  assert.equal(back.title, '测试标签');
  await input(back, { type: 'keyDown', key: 'F5' });
  assert.equal((await afterNavigation(back)).title, '测试标签');
});

test('shared Chromium profile keeps workspace targets, origins and lifetimes separate', async t => {
  const { chromium } = await import('playwright-core');
  const { engineExecutable } = await import('./runtime.mjs');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'open-browser-shared-test-'));
  const context = await chromium.launchPersistentContext(dir, { executablePath: await engineExecutable(),
    headless: process.env.OPEN_BROWSER_HEADED_TESTS !== '1' });
  const groups = new Map();
  const events = [];
  const service = new BrowserService(context.browser(), { sharedContext: context,
    groupTab: async (page, id, name, mode, agentName, pageId) => groups.set(page, { id, name, mode, agentName, pageId }),
    onActivity(view) {
      events.push(view);
      // A stalled host must not hold the workspace scheduler or handoff.
      return new Promise(() => {});
    } });
  const hits = [];
  const outside = createServer((req, res) => {
    hits.push(req.url);
    res.setHeader('content-type', 'text/html');
    res.end('<p>ordinary tab reached destination</p>');
  });
  outside.listen(0, '127.0.0.1');
  await once(outside, 'listening');
  const other = 'http://127.0.0.1:' + outside.address().port;
  const site = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.url === '/signin') res.setHeader('set-cookie', 'sid=shared; Path=/; HttpOnly');
    if (req.url === '/redirect') {
      res.writeHead(302, { location: other + '/redirected' }).end();
      return;
    }
    res.end('<p>' + (req.headers.cookie || 'guest') + '</p><a target="_blank" href="/child">new tab</a>');
  });
  site.listen(0, '127.0.0.1');
  await once(site, 'listening');
  const origin = 'http://127.0.0.1:' + site.address().port;
  t.after(async () => {
    await service.shutdown();
    await context.close();
    await rm(dir, { recursive: true, force: true });
    for (const server of [site, outside]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const personal = context.pages()[0] || await context.newPage();
  await personal.goto(origin + '/signin');
  const focusProbe = await context.newCDPSession(personal);
  await focusProbe.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await personal.bringToFront();
  await personal.evaluate(() => {
    window.lostFocus = false;
    window.addEventListener('blur', () => { window.lostFocus = true; });
  });
  const call = (method, params) => service.call(method, params, 'desktop');
  for (const agentName of [null, 42, '😀'.repeat(81)])
    await assert.rejects(call('createWorkspace', { name: '测试任务', agentName }), { code: 'invalid_params' });
  await assert.rejects(call('createWorkspace', { name: '   ', agentName: 'Agent' }), { code: 'task_name_required' });
  const [a,b] = await Promise.all([
    call('createWorkspace', { name: 'first', agentName: '  测试\n\u001b助手  ' }),
    call('createWorkspace', { name: 'second' }),
  ]);
  assert.equal(a.agentName, '测试 助手');
  assert.equal(b.agentName, 'Agent');
  assert.equal((await call('getWorkspace', a)).agentName, a.agentName);
  assert.equal((await call('listWorkspaces', {})).find(ws => ws.workspaceId === a.workspaceId).agentName, a.agentName);
  const [first, second] = await Promise.all([a,b].map(ws => call('openPage',
    { workspaceId: ws.workspaceId, url: origin + '/' + ws.name })));
  assert.equal(await personal.evaluate(() => window.lostFocus), false);
  assert.match((await call('observe', first)).text, /sid=\[redacted\]/);
  assert.match((await call('observe', second)).text, /sid=\[redacted\]/);
  await assert.rejects(call('observe', { ...second, pageId: first.pageId }), { code: 'page_not_found' });
  const page = [...groups.keys()].find(page => groups.get(page).id === a.workspaceId);
  assert.equal(groups.get(page).agentName, a.agentName);
  assert.equal(groups.get(page).pageId, first.pageId);
  const opening = events.filter(view => view.workspaceId === a.workspaceId)
    .map(view => view.activity.current).filter(job => job?.kind === 'openPage');
  assert.equal(opening[0].state, 'queued');
  assert.ok(opening.some(job => job.state === 'running' && !job.pageId));
  assert.ok(opening.some(job => job.state === 'running' && job.pageId === first.pageId));
  assert.ok(events.some(view => view.workspaceId === a.workspaceId &&
    view.activity.current?.kind === 'openPage' && view.activity.current.pageId === first.pageId &&
    view.pages.some(item => item.pageId === first.pageId && item.origin === origin)));
  await page.evaluate(() => localStorage.setItem('shared', 'yes'));
  assert.equal(await personal.evaluate(() => localStorage.getItem('shared')), 'yes');
  assert.equal(groups.has(personal), false);
  await assert.rejects(call('openPage', { workspaceId: a.workspaceId, url: origin + '/redirect' }),
    { code: 'navigation_failed' });
  assert.equal(await page.evaluate(url => window.open(url) === null, other + '/workspace-popup'), true);
  await page.evaluate(url => fetch(url).catch(() => {}), other + '/workspace-fetch');
  assert.deepEqual(hits, []);
  const popupReady = personal.waitForEvent('popup');
  await personal.evaluate(url => { window.open(url); }, other + '/ordinary-popup');
  const popup = await popupReady;
  await popup.waitForLoadState();
  assert.ok(hits.includes('/ordinary-popup'));
  assert.equal(groups.has(popup), false);
  const observation = await call('observe', first);
  await call('act', { ...first, operationId: 'new-tab', documentId: observation.documentId,
    controlGeneration: observation.controlGeneration, actions: [{ kind: 'click', ref: observation.elements[0].ref }] });
  await call('observe', first);
  assert.equal((await call('getWorkspace', first)).pages.length, 2);
  assert.ok(events.some(view => view.workspaceId === a.workspaceId &&
    view.activity.current?.stepKind === 'click' && view.activity.current.pageId === first.pageId));
  assert.ok(events.some(view => view.workspaceId === a.workspaceId &&
    view.activity.current?.kind === 'act' && view.activity.current.completedSteps === 1));
  await assert.rejects(call('takeControl', { ...first, controlGeneration: 'old' }), { code: 'stale_control' });
  const human = await call('takeControl', { ...first, controlGeneration: a.controlGeneration });
  assert.equal(groups.get(page).mode, 'human');
  assert.equal(groups.get(page).agentName, a.agentName);
  await assert.rejects(call('returnToAgent', { ...first, controlGeneration: a.controlGeneration }), { code: 'stale_control' });
  await call('returnToAgent', { ...first, controlGeneration: human.controlGeneration });
  assert.equal(groups.get(page).mode, 'agent');
  // Supply an off-scope test document locally, independently of the network
  // restriction. Check the Agent API even when Chromium already has a page.
  const offlineUrl = other + '/private-document';
  await page.route(offlineUrl, route => route.fulfill({ contentType: 'text/html',
    body: '<title>Private title</title><button>Private action</button>' }));
  for (const destination of [offlineUrl, 'chrome://version/']) {
    await call('takeControl', first);
    await page.goto(destination);
    const restored = await call('returnToAgent', first);
    const summary = restored.pages.find(tab => tab.pageId === first.pageId);
    assert.deepEqual({ title: summary.title, origin: summary.origin }, { title: '', origin: 'null' });
    await assert.rejects(call('observe', first), { code: 'origin_denied' });
    await assert.rejects(call('act', { ...first, operationId: destination, documentId: observation.documentId,
      controlGeneration: restored.controlGeneration, actions: [{ kind: 'click', ref: observation.elements[0].ref }] }),
    { code: 'origin_denied' });
  }
  await call('closeWorkspace', first);
  const modes = events.filter(view => view.workspaceId === a.workspaceId).map(view => view.mode);
  assert.ok(modes.includes('transferring') && modes.includes('human'));
  assert.equal(modes.at(-1), 'closed');
  assert.equal(page.isClosed(), true);
  assert.equal(personal.isClosed(), false);
  assert.equal(popup.isClosed(), false);
  assert.match((await call('observe', second)).text, /sid=\[redacted\]/);
});
