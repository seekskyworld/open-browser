import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { launchBrowser } from './control.mjs';
import { BrowserService } from './engine-service.mjs';

test('workspace observation and scoped network permissions in Chromium', async t => {
  const servers = [];
  async function site(handler) {
    const server = createServer(handler);
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }
  const requests = [];
  const passiveHeaders = [];
  const assets = await site((req, res) => {
    requests.push(req.url);
    passiveHeaders.push(req.headers);
    res.setHeader('set-cookie','asset_tracking=1; Path=/');
    res.writeHead(200, { 'content-type': 'text/css' }).end('body { color: black; }');
  });
  const frame = await site((req, res) => res.writeHead(200, { 'content-type': 'text/html' })
    .end('<p>frame-' + (req.url === '/private' ? 'hidden' : 'authorized') + '</p><button>Frame button</button>'));
  const root = await site((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }).end(
      '<label>Color<select aria-label="Select color" onchange="document.querySelector(\'output\').textContent=this.value">' +
      '<option value="blue">Blue</option><option value="green">Green</option></select></label><output>Choose</output>' +
      '<input type="password" value="never-print-this"><button onclick="setTimeout(()=>document.querySelector(\'output\').textContent=\'Ready\',150)">Next</button>' +
      '<link rel="stylesheet" href="' + assets + '/style.css"><script src="' + assets + '/run.js"></script>' +
      '<iframe src="' + frame + '/visible"></iframe><iframe hidden src="' + frame + '/private"></iframe>' +
      '<iframe sandbox src="' + frame + '/opaque"></iframe><iframe src="' + assets + '/denied-frame"></iframe>');
  });
  const browser = await launchBrowser();
  const service = new BrowserService(browser);
  t.after(async () => {
    await service.shutdown();
    await browser.close();
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
  const call = (method, params) => service.call(method, params, 'fixture');
  const ws = await call('createWorkspace', { name: '测试任务', allowedOrigins: [root, frame] });
  const handle = await call('openPage', { workspaceId: ws.workspaceId, url: root });
  const snapshot = (includeFrames = false) => call('observe', { ...handle, includeFrames });
  const workspace = () => call('getWorkspace', {workspaceId: ws.workspaceId});
  const grant = (origin, scope, controlGeneration = ws.controlGeneration) =>
    call('grantOrigin', {workspaceId: ws.workspaceId, origin, scope, controlGeneration});
  async function act(before, actions, observeAfter) {
    const operationId = randomUUID();
    const request = { ...handle, controlGeneration: before.controlGeneration, documentId: before.documentId,
      operationId, actions, observeAfter };
    let receipt = await call('act', request);
    const deadline = Date.now() + 6000;
    while (['queued','running'].includes(receipt.state) && Date.now() < deadline) {
      await delay(20);
      receipt = await call('getOperation', {workspaceId: ws.workspaceId, operationId});
    }
    return receipt;
  }

  await t.test('default observation confines text and controls to the top page', async () => {
    const view = await snapshot();
    assert.ok(!view.frames);
    assert.doesNotMatch(JSON.stringify(view), /never-print-this|Frame button|frame-authorized/);
  });
  await t.test('explicit frame reading honors origin, visibility and opaque sandbox; returns no action handles', async () => {
    const view = await snapshot(true);
    assert.deepEqual(view.frames, [{origin: frame, text: 'frame-authorized Frame button'}]);
  });
  await t.test('blocked request summaries omit URL paths and describe the denied type', async () => {
    const view = await snapshot();
    assert.ok(view.blockedRequests.some(r => r.origin === assets && r.resourceType === 'stylesheet' && r.reason === 'origin_denied'));
    assert.doesNotMatch(JSON.stringify(view.blockedRequests), /style\.css|run\.js/);
  });
  await t.test('grants require a matching recorded origin, scope and current control generation', async () => {
    await assert.rejects(grant(root, 'resource'), {code: 'origin_not_requested'});
    await assert.rejects(grant(assets, 'resource', 'stale'), {code: 'stale_control'});
    assert.ok((await workspace()).blockedOrigins.some(r => r.origin === assets && r.scope === 'resource'));
    assert.deepEqual(await grant(assets, 'resource'), {origin: assets, scope: 'resource', granted: true});
  });
  await t.test('resource-only grant loads CSS and keeps script, document and credential scopes closed', async () => {
    const context = service.workspaces.get(ws.workspaceId).context;
    await context.addCookies([{url:assets,name:'existing_session',value:'private'}]);
    const h = await call('openPage', {workspaceId: ws.workspaceId, url: root + '/fresh'});
    const view = await call('observe', h);
    assert.ok(requests.includes('/style.css'));
    assert.ok(passiveHeaders.every(h => !h.cookie && !h.authorization && !h.referer));
    assert.ok(!(await context.cookies(assets)).some(c => c.name === 'asset_tracking'));
    assert.ok(!requests.includes('/run.js') && !requests.includes('/denied-frame'));
    assert.ok(view.blockedRequests.some(r => r.resourceType === 'script'));
    await assert.rejects(call('openPage', {workspaceId: ws.workspaceId, url: assets}), {code: 'origin_denied'});
    await assert.rejects(call('setCredential', {workspaceId: ws.workspaceId, origin: assets,
      credentialRef: 'x', value: 'test'}), {code: 'origin_denied'});
  });
  await t.test('a declared passive origin works from the first page load', async () => {
    const other = await call('createWorkspace', { name: '测试任务', allowedOrigins: [root], resourceOrigins: [assets]});
    const seen = requests.length;
    await call('openPage', {workspaceId: other.workspaceId, url: root});
    assert.ok(requests.slice(seen).includes('/style.css'));
  });
  await t.test('select exposes option choices and returns a fresh full observation', async () => {
    const view = await snapshot(), select = view.elements.find(e => e.role === 'combobox');
    assert.deepEqual(select.options, [{label:'Blue',value:'blue'},{label:'Green',value:'green'}]);
    const receipt = await act(view, [{kind:'select', ref:select.ref, value:'green'}], 'full');
    assert.equal(receipt.state, 'completed');
    assert.equal(receipt.phase, 'completed');
    assert.equal(receipt.totalSteps, 1);
    assert.match(receipt.observation.text, /green/);
  });
  await t.test('action delta reports visible changes after a bounded wait', async () => {
    const view = await snapshot(), button = view.elements.find(e => e.name === 'Next');
    const receipt = await act(view, [{kind:'click',ref:button.ref},{kind:'wait',text:'Ready',timeoutMs:2000}], 'delta');
    assert.equal(receipt.completedSteps,2);
    assert.equal(receipt.phase, 'completed');
    assert.equal(receipt.totalSteps, 2);
    assert.equal(receipt.delta.textChanged,true);
    assert.match(receipt.delta.text,/Ready/);
  });
  await t.test('a wait timeout has a definite failure with no mutating step', async () => {
    const result = await act(await snapshot(), [{kind:'wait',text:'absent',timeoutMs:70}]);
    assert.equal(result.error,'wait_timeout');
    assert.equal(result.completedSteps,0);
  });
  await t.test('wait rejects an oversized timeout before submission', async () => {
    await assert.rejects(act(await snapshot(), [{kind:'wait',text:'x',timeoutMs:10001}]),{code:'invalid_actions'});
  });
  await t.test('a past action snapshot cannot be read after human takeover', async () => {
    const view = await snapshot();
    const result = await act(view,[{kind:'wait',text:'Ready'}],'full');
    assert.ok(result.observation);
    await call('takeControl',handle);
    const past = await call('getOperation',{workspaceId:ws.workspaceId,operationId:result.operationId});
    assert.ok(!past.observation);
    await call('returnToAgent',{workspaceId:ws.workspaceId});
    assert.ok(!(await call('getOperation',{workspaceId:ws.workspaceId,operationId:result.operationId})).observation);
  });
  await t.test('navigation approval is specific to the blocked destination', async () => {
    const w = await workspace();
    await grant(assets,'navigation',w.controlGeneration);
    const opened = await call('openPage',{workspaceId:ws.workspaceId,url:assets});
    assert.ok(opened.pageId);
  });
});

test('native labels expose actionable visible targets and keep private names and values out of observations', async t => {
  const html = `<form>
    <label for="visible">Visible <span data-open-browser-private>private-inline-name</span></label>
    <label for="visible" hidden>hidden-label-name</label>
    <input id="visible" value="private-input-value">
    <label>Wrapped <input type="password" value="private-password"></label>
    <label for="styled">Remember <span>me</span><span aria-hidden="true">hidden-caption</span></label>
    <input hidden id="styled" type="checkbox" onchange="document.querySelector('output').textContent=String(this.checked)">
    <output>unchecked</output>
    <label for="disabled">Disabled control</label><input hidden disabled id="disabled" type="checkbox">
    <label for="fieldset">Disabled fieldset</label><fieldset disabled><input hidden id="fieldset" type="checkbox"></fieldset>
    <label for="aria">Disabled owner</label><div aria-disabled="true"><input hidden id="aria" type="radio"></div>
    <label for="inert">Inert owner</label><div inert><input hidden id="inert" type="checkbox"></div>
    <label for="private">Private control</label><div data-open-browser-private><input hidden id="private" type="checkbox"></div>
    <label for="none">Orphan label</label>
    <label for="metadata">Hidden metadata</label><input type="hidden" id="metadata" value="private-metadata">
    <label data-open-browser-private for="styled">private-label-name</label>
    <button type="button">Continue <span data-open-browser-private>private-button-name</span></button>
  </form>`;
  const server = createServer((_req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(html));
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  const origin='http://127.0.0.1:'+server.address().port;
  const browser=await launchBrowser(), service=new BrowserService(browser);
  t.after(async()=>{
    await service.shutdown();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve=>server.close(resolve));
  });
  const call=(method,params)=>service.call(method,params,'owner');
  const {workspaceId}=await call('createWorkspace',{name:'测试任务',allowedOrigins:[origin]});
  const page=await call('openPage',{workspaceId,url:origin});
  const owner=await call('observe',page), reader=await call('observeReadOnly',page);
  for(const view of [owner,reader]) {
    assert.deepEqual(view.elements.map(({role,name})=>[role,name]),[
      ['textbox','Visible'],['textbox','Wrapped'],['label','Remember me'],['button','Continue']]);
    assert.doesNotMatch(JSON.stringify(view),/private-inline-name|hidden-label-name|private-input-value|private-password|hidden-caption|private-metadata|private-label-name|private-button-name/);
  }
  assert.ok(reader.elements.every(element=>!element.ref));
  const operationId=randomUUID();
  await call('act',{...page,documentId:owner.documentId,controlGeneration:owner.controlGeneration,operationId,
    actions:[{kind:'click',ref:owner.elements.find(element=>element.role==='label').ref}]});
  await service.workspaces.get(workspaceId).tail;
  assert.equal((await call('getOperation',{workspaceId,operationId})).state,'completed');
  assert.match((await call('observe',page)).text,/Remember me true/);
});

test('semantic pointer actions preserve real event order and state', async t => {
  const server = createServer((_req, res) => res.writeHead(200, {'content-type':'text/html'}).end(`
    <style>#scroll { height: 40px; overflow: auto } #space { height: 180px }</style>
    <button id="hover" onmouseenter="this.dataset.hovered='yes'">Hover</button>
    <button id="double" ondblclick="this.dataset.double='yes'">Double</button>
    <input id="press" aria-label="Press" onkeydown="this.dataset.key=event.key">
    <input id="fill" aria-label="Fill">
    <div id="source" role="button" aria-label="Source" draggable="true">Source</div><div id="target" role="button" aria-label="Target" ondragover="event.preventDefault()" ondrop="this.dataset.dropped='yes'">Target</div>
    <div id="scroll" role="region" aria-label="Scroll area"><div id="space"><button id="scroll-target">Scroll target</button></div></div>`));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const browser = await launchBrowser(), service = new BrowserService(browser);
  t.after(async () => {
    await service.shutdown(); await browser.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const call = (method, params) => service.call(method, params, 'pointer-test');
  const workspace = await call('createWorkspace', { name: '测试任务', allowedOrigins:[origin]});
  const page = await call('openPage', {workspaceId:workspace.workspaceId, url:origin});
  const view = await call('observe', page);
  const ref = name => view.elements.find(element => element.name === name).ref;
  async function act(action) {
    const operationId = randomUUID();
    const receipt = await call('act', {...page, documentId:view.documentId, controlGeneration:view.controlGeneration, operationId, actions:[action]});
    await service.workspaces.get(workspace.workspaceId).tail;
    return call('getOperation', {workspaceId:workspace.workspaceId, operationId});
  }
  assert.equal((await act({kind:'hover', ref:ref('Hover')})).state, 'completed');
  assert.equal((await act({kind:'doubleClick', ref:ref('Double')})).state, 'completed');
  assert.equal((await act({kind:'press', ref:ref('Press'), key:'Enter'})).state, 'completed');
  const filled = await act({kind:'fill', ref:ref('Fill'), value:'open-browser'});
  assert.equal(filled.fillOutcome, 'exact');
  assert.equal((await act({kind:'scroll', ref:ref('Scroll target'), deltaY:120})).state, 'completed');
  const source = ref('Source'), target = ref('Target');
  const drag = await act({kind:'drag', ref:source, toRef:target});
  assert.ok(['completed', 'outcome_unknown'].includes(drag.state));
  const site = service.workspaces.get(workspace.workspaceId).pages.get(page.pageId).page;
  assert.equal(await site.locator('#hover').getAttribute('data-hovered'), 'yes');
  assert.equal(await site.locator('#double').getAttribute('data-double'), 'yes');
  assert.equal(await site.locator('#scroll').evaluate(node => node.scrollTop > 0), true);
});

test('reobserving reordered identical buttons preserves their targets and retires a replacement', async t => {
  const server = createServer((_req, res) => res.writeHead(200, {'content-type':'text/html'}).end(
    '<button id="first">Pick</button><button id="second">Pick</button><output></output>' +
    '<script>document.onclick = event => document.querySelector("output").textContent = event.target.id</script>'
  ));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await launchBrowser(), service = new BrowserService(browser);
  t.after(async () => {
    await service.shutdown();
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const call = (method, params) => service.call(method, params, 'owner');
  const {workspaceId} = await call('createWorkspace', { name: '测试任务' });
  const page = await call('openPage', {workspaceId, url:'http://127.0.0.1:' + server.address().port});
  const original = await call('observe', page);
  const site = service.workspaces.get(workspaceId).pages.get(page.pageId).page;
  await site.evaluate(() => {
    const second = document.getElementById('second');
    document.body.prepend(second);
    const first = document.getElementById('first');
    first.replaceWith(first.cloneNode(true));
  });
  const current = await call('observe', page);
  assert.equal(current.elements[0].ref, original.elements[1].ref);
  assert.notEqual(current.elements[1].ref, original.elements[0].ref);
  async function click(ref) {
    const operationId = randomUUID();
    await call('act', {...page, documentId:original.documentId, controlGeneration:original.controlGeneration,
      operationId, actions:[{kind:'click',ref}]});
    await service.workspaces.get(workspaceId).tail;
    return call('getOperation', {workspaceId, operationId});
  }
  assert.equal((await click(original.elements[0].ref)).error, 'stale_ref');
  assert.equal((await click(original.elements[1].ref)).state, 'completed');
  assert.equal(await site.locator('output').textContent(), 'second');
});
