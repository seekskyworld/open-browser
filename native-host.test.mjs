import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const skill = path.join(root, 'skills/open-browser/scripts/open-browser');

async function skillRequest(env, method, params = {}) {
  const child = spawn(skill, [method], { cwd: root, env });
  const exit = once(child, 'close');
  const out = [], err = [];
  child.stdout.on('data', data => out.push(data));
  child.stderr.on('data', data => err.push(data));
  child.stdin.end(JSON.stringify(params));
  const [code] = await exit;
  if (code !== 0) {
    const detail = JSON.parse(Buffer.concat(err).toString()).error;
    throw Object.assign(new Error(detail.message), { code: detail.code });
  }
  return JSON.parse(Buffer.concat(out).toString());
}

async function agentSocketRequest(stateDir, method, params) {
  const token = (await readFile(path.join(stateDir, 'open-browser.token'), 'utf8')).trim();
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: path.join(stateDir, 'open-browser.sock'), path: '/v1/call', method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    }, res => {
      const body = [];
      res.on('data', chunk => body.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(body).toString()) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify({ method, params }));
  });
}

test('native host shares Skill workspaces, owns address navigation and cleans up on EOF', {
  skip: process.platform === 'win32' && 'The bundled macOS Skill entry point is a shell script.',
}, async t => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ob-native-'));
  const env = { ...process.env, OPEN_BROWSER_STATE_DIR: stateDir };
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>本地任务</title><main>原生宿主验收</main>' +
      '<input aria-label="输入" style="position:absolute;left:10px;top:50px;width:150px;height:35px">' +
      '<output></output><script>document.querySelector("input").oninput = e => ' +
      'document.querySelector("output").textContent = e.target.value;</script>');
  });
  let secondaryVisits = 0;
  const secondarySite = http.createServer((req, res) => {
    if (req.url.startsWith('/address-test')) secondaryVisits++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end('<!doctype html><title>第二站点</title><main>第二站点已打开</main>');
  });
  const child = spawn(process.execPath, ['service.mjs', '--native-host', '--headless'], {
    cwd: root, env: { ...env, DEBUG: 'pw:protocol' },
  });
  const exit = once(child, 'close');
  const stdout = createInterface({ input: child.stdout });
  const frames = stdout[Symbol.asyncIterator]();
  let nextId = 0;
  async function hostCall(method, params = {}) {
    const id = ++nextId;
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    const frame = JSON.parse((await frames.next()).value);
    assert.equal(frame.id, id);
    if (frame.error) throw Object.assign(new Error(frame.error), { code: frame.error });
    return frame.result;
  }
  // Keep only method counts. The raw protocol can include page content.
  let targetCommands = 0;
  let navigationCommands = 0;
  const diagnostics = createInterface({ input: child.stderr });
  diagnostics.on('line', line => {
    if (!line.includes('SEND')) return;
    if (line.includes('"method":"Target.createTarget"')) targetCommands++;
    if (line.includes('"method":"Page.navigate"')) navigationCommands++;
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exit;
    for (const server of [site, secondarySite]) {
      if (!server.listening) continue;
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(stateDir, { recursive: true, force: true });
  });
  // Ensure a regressed host cannot hang the test runner waiting for a frame.
  const deadline = setTimeout(() => child.kill('SIGKILL'), 20_000);
  t.after(() => clearTimeout(deadline));
  await Promise.all([site, secondarySite].map(server => {
    server.listen(0, '127.0.0.1');
    return once(server, 'listening');
  }));
  const firstOrigin = 'http://127.0.0.1:' + site.address().port;
  const secondOrigin = 'http://127.0.0.1:' + secondarySite.address().port;

  const ready = JSON.parse((await frames.next()).value);
  assert.equal(ready.ready, true);
  assert.deepEqual(await hostCall('listWorkspaces'), []);
  assert.equal(targetCommands, 0, 'native startup must not open a management tab');
  assert.equal(navigationCommands, 0, 'native startup must not navigate to a management site');
  const workspace = await skillRequest(env, 'createWorkspace', { name: 'Skill 工作区' });
  assert.deepEqual((await hostCall('getWorkspace', workspace)).pages, []);
  const handle = await skillRequest(env, 'openPage', {
    workspaceId: workspace.workspaceId,
    url: firstOrigin,
  });
  const [nativeWorkspace] = await hostCall('listWorkspaces');
  assert.equal(nativeWorkspace.workspaceId, handle.workspaceId);
  assert.equal(nativeWorkspace.mode, 'agent');
  assert.equal(nativeWorkspace.pages[0].pageId, handle.pageId);
  assert.equal(nativeWorkspace.activity.phase, 'completed');
  assert.ok(targetCommands > 0 && navigationCommands > 0, 'protocol counters observe the actual task page');
  assert.match((await hostCall('previewPage', handle)).text, /原生宿主验收/);

  for (const method of ['takeControl', 'returnToAgent', 'setCredential', 'previewPage',
    'pageInput', 'pageFrame', 'closePage', 'pageNew', 'pageNavigate', 'pageLocation'])
    await assert.rejects(skillRequest(env, method, handle), { code: 'UNKNOWN_METHOD' });
  for (const method of ['pageNew', 'pageNavigate', 'pageLocation']) {
    const response = await agentSocketRequest(stateDir, method, handle);
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, 'forbidden');
  }
  const selectedTab = await hostCall('pageFrame', { ...handle, width: 640, height: 480 });
  assert.equal(selectedTab.width, 640);
  assert.equal(selectedTab.height, 480);
  assert.equal(Buffer.from(selectedTab.data, 'base64').readUInt16BE(0), 0xffd8);
  const input = (frame, event) => hostCall('pageInput', { ...handle, event,
    documentId: frame.documentId, controlGeneration: frame.controlGeneration });
  await assert.rejects(input(selectedTab, { type: 'text', text: '未接管' }));
  const transferred = await hostCall('takeControl', handle);
  assert.equal(transferred.mode, 'human');
  await assert.rejects(skillRequest(env, 'observe', handle), { code: 'workspace_under_user_control' });
  const humanTab = await hostCall('pageFrame', { ...handle, width: 640, height: 480 });
  for (const type of ['mouseDown', 'mouseUp'])
    await input(humanTab, { type, x: 50, y: 65, button: 'left' });
  await input(humanTab, { type: 'text', text: '手动填写' });
  const returned = await hostCall('returnToAgent', { workspaceId: handle.workspaceId });
  assert.equal(returned.mode, 'agent');
  await assert.rejects(input(humanTab, { type: 'text', text: '交回后的旧输入' }));
  const observation = await skillRequest(env, 'observe', handle);
  assert.notEqual(observation.controlGeneration, transferred.controlGeneration);
  assert.match(observation.text, /原生宿主验收/);
  assert.match(observation.text, /手动填写/);
  assert.doesNotMatch(observation.text, /交回后的旧输入|未接管/);
  const other = await skillRequest(env, 'createWorkspace', { name: '测试任务', allowedOrigins: [firstOrigin] });
  const newAddress = secondOrigin + '/address-test?session=local-marker#bookmark';
  const firstAddress = firstOrigin + '/';
  const address = () => hostCall('pageLocation', handle);
  const navigate = (action, url) => hostCall('pageNavigate', { ...handle, action, ...(url && { url }) });
  function checkLocation(state, url, canGoBack, canGoForward) {
    assert.equal(state.url, url);
    assert.equal(state.canGoBack, canGoBack);
    assert.equal(state.canGoForward, canGoForward);
  }

  await assert.rejects(skillRequest(env, 'openPage', { workspaceId: handle.workspaceId, url: newAddress }),
    { code: 'origin_denied' });
  assert.equal(secondaryVisits, 0);
  checkLocation(await address(), firstAddress, false, false);
  assert.equal((await hostCall('getWorkspace', workspace)).mode, 'agent', 'reading the address preserves control');
  checkLocation(await navigate('go', newAddress), newAddress, true, false);
  assert.ok(secondaryVisits >= 1);
  assert.equal((await hostCall('getWorkspace', workspace)).mode, 'human');
  checkLocation(await address(), newAddress, true, false);
  assert.equal((await hostCall('pageFrame', handle)).title, '第二站点');
  await assert.rejects(skillRequest(env, 'observe', handle), { code: 'workspace_under_user_control' });
  const publicSummary = await skillRequest(env, 'getWorkspace', { workspaceId: handle.workspaceId });
  assert.equal(publicSummary.pages[0].origin, secondOrigin);
  assert.doesNotMatch(JSON.stringify(publicSummary), /address-test|local-marker|bookmark/);

  checkLocation(await navigate('back'), firstAddress, false, true);
  assert.equal((await hostCall('pageFrame', handle)).title, '本地任务');
  checkLocation(await navigate('forward'), newAddress, true, false);
  const beforeReload = secondaryVisits;
  checkLocation(await navigate('reload'), newAddress, true, false);
  assert.ok(secondaryVisits > beforeReload, 'reloading reaches the destination server');

  const next = await hostCall('pageNew', { workspaceId: handle.workspaceId, url: firstOrigin + '/new-tab' });
  assert.notEqual(next.pageId, handle.pageId);
  checkLocation(await hostCall('pageLocation', next), firstOrigin + '/new-tab', false, false);
  checkLocation(await address(), newAddress, true, false);
  await hostCall('closePage', next);
  await hostCall('returnToAgent', { workspaceId: handle.workspaceId });
  assert.match((await skillRequest(env, 'observe', handle)).text, /第二站点已打开/);
  const beforeDenied = secondaryVisits;
  await assert.rejects(skillRequest(env, 'openPage', { workspaceId: other.workspaceId, url: newAddress }),
    { code: 'origin_denied' });
  assert.equal(secondaryVisits, beforeDenied);
  await skillRequest(env, 'closeWorkspace', { workspaceId: other.workspaceId });
  await hostCall('closePage', handle);
  assert.deepEqual((await hostCall('getWorkspace', workspace)).pages, []);
  await skillRequest(env, 'closeWorkspace', { workspaceId: handle.workspaceId });
  assert.deepEqual(await hostCall('listWorkspaces'), []);

  child.stdin.end();
  assert.equal((await exit)[0], 0);
  await assert.rejects(access(path.join(stateDir, 'open-browser.token')), { code: 'ENOENT' });
  await assert.rejects(access(path.join(stateDir, 'open-browser.sock')), { code: 'ENOENT' });
});
