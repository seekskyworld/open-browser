import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectDir = fileURLToPath(new URL('./', import.meta.url));

async function cli(method, params, stateDir, options = {}) {
  const child = spawn(process.execPath, [path.join(projectDir, 'cli.mjs'), method], {
    env: { ...process.env, OPEN_BROWSER_STATE_DIR: stateDir, ...options.env },
  });
  const finished = once(child, 'close');
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  child.stdin.end(JSON.stringify(params));
  const status = (await finished)[0];
  if(options.error) { assert.equal(status,1); return JSON.parse(errors).error.code; }
  assert.equal(status, 0, errors);
  return JSON.parse(output);
}

async function tryAnonymousRequest(socketPath) {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/v1/call', method: 'POST' }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ method: 'listWorkspaces' }));
  });
}

test('a CLI-created page survives process exit and can be observed by an authorized MCP client', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ob-service-'));
  const original = process.env.OPEN_BROWSER_STATE_DIR;
  const mcp = new Client({ name: 'open-browser-integration', version: '0.1.0' });
  let app;
  try {
    process.env.OPEN_BROWSER_STATE_DIR = stateDir;
    const { startApplication } = await import('./service.mjs');
    const { socketPath } = await import('./paths.mjs');
    app = await startApplication({ headless: true, mode: 'web' });
    assert.equal(await tryAnonymousRequest(socketPath), 403);

    const workspace = await cli('createWorkspace', { name: '测试任务' }, stateDir);
    const handle = await cli('openPage', {
      workspaceId: workspace.workspaceId, url: app.studio.demoUrl,
    }, stateDir);
    assert.equal(handle.workspaceId, workspace.workspaceId);
    await mcp.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(projectDir, 'mcp.mjs')],
      env: { OPEN_BROWSER_STATE_DIR: stateDir },
    }));
    const observation = await mcp.callTool({ name: 'observe', arguments: handle });
    assert.ok(!observation.isError, observation.content[0].text);
    const snapshot = JSON.parse(observation.content[0].text);
    assert.ok(snapshot.documentId && snapshot.controlGeneration);
    assert.ok(snapshot.elements.some(el => el.role === 'button' && el.name.includes('登录')));
    assert.ok(!JSON.stringify(snapshot).includes(app.studio.demoAccount.password));
    const readerToken = path.join(stateDir,'reader-token');
    const {principalId} = await cli('admin.pair',{name:'visual-reader',tokenFile:readerToken},stateDir);
    const readerEnv={OPEN_BROWSER_CLIENT_TOKEN_FILE:readerToken};
    const readerMcp=new Client({name:'visual-readonly',version:'1.0.0'});
    const {OpenBrowserClient}=await import('./sdk.mjs');
    const reader=new OpenBrowserClient({tokenPath:readerToken});
    const scope={principalId,workspaceId:handle.workspaceId};
    const origin=new URL(app.studio.demoUrl).origin;
    const region={x:0,y:0,width:80,height:50};
    const args={...handle,region};
    try {
      await readerMcp.connect(new StdioClientTransport({command:process.execPath,args:[path.join(projectDir,'mcp.mjs')],
        env:{OPEN_BROWSER_STATE_DIR:stateDir,...readerEnv}}));
      await cli('admin.grant',{...scope,permission:'read'},stateDir);
      async function denied() {
        await assert.rejects(reader.captureVisual(handle,{region}),{code:'pixel_permission_required'});
        assert.equal(await cli('captureVisual',args,stateDir,{env:readerEnv,error:true}),'pixel_permission_required');
        const response=await readerMcp.callTool({name:'captureVisual',arguments:args});
        assert.equal(response.isError,true);
        assert.equal(JSON.parse(response.content[0].text).code,'pixel_permission_required');
      }
      await denied();
      await cli('admin.setPixelPermission',{...scope,origin,allow:true},stateDir);
      // Pixel equality across transports needs the same active compositor surface.
      // The temporary headless browser can initially display its studio window.
      const browser=app.page.context().browser();
      const target=browser.contexts().flatMap(context=>context.pages()).find(page=>page.url()===app.studio.demoUrl);
      assert.ok(target,'temporary demo page is open');
      await target.bringToFront();
      const frame=await reader.captureVisual(handle,{region});
      assert.equal(frame.mimeType,'image/png');
      await new Promise(r=>setTimeout(r,160));
      const cliFrame=await cli('captureVisual',args,stateDir,{env:readerEnv});
      assert.equal(cliFrame.data,frame.data);
      await new Promise(r=>setTimeout(r,160));
      const response=await readerMcp.callTool({name:'captureVisual',arguments:args});
      assert.ok(!response.isError);
      assert.equal(response.content[0].type,'image');
      assert.equal(response.content[0].data,frame.data);
      assert.deepEqual(JSON.parse(response.content[1].text).clip,region);
      await assert.rejects(reader.act(handle,{operationId:'readonly',actions:[]}),{code:'forbidden'});
      await cli('admin.revoke',scope,stateDir);
      await cli('admin.grant',{...scope,permission:'read'},stateDir);
      await denied();
    } finally { await readerMcp.close(); }
    const listing = await mcp.listTools();
    for (const name of ['takeControl', 'returnToAgent', 'setCredential', 'previewPage', 'showPage']) {
      assert.ok(!listing.tools.some(tool => tool.name === name));
      await assert.rejects(mcp.callTool({ name, arguments: { workspaceId: handle.workspaceId } }));
    }
    const closed = await mcp.callTool({ name: 'closeWorkspace', arguments: { workspaceId: handle.workspaceId } });
    assert.ok(!closed.isError, closed.content[0].text);
    const workspaces = await cli('listWorkspaces', {}, stateDir);
    assert.ok(!JSON.stringify(workspaces).includes(handle.workspaceId));
  } finally {
    await mcp.close();
    await app?.close();
    if (original === undefined) delete process.env.OPEN_BROWSER_STATE_DIR;
    else process.env.OPEN_BROWSER_STATE_DIR = original;
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a second service for the same profile is rejected without disturbing the owner', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'ob-single-owner-'));
  const original = process.env.OPEN_BROWSER_STATE_DIR;
  let app;
  try {
    process.env.OPEN_BROWSER_STATE_DIR = stateDir;
    const { startApplication } = await import('./service.mjs');
    const paths = await import('./paths.mjs');
    app = await startApplication({ headless: true, mode: 'web' });
    assert.equal((await readFile(paths.pidPath, 'utf8')).trim(), String(process.pid));
    await assert.rejects(startApplication({ headless: true, mode: 'web' }), error =>
      error?.code === 'EADDRINUSE');
    assert.equal((await readFile(paths.pidPath, 'utf8')).trim(), String(process.pid));
  } finally {
    await app?.close();
    await assert.rejects(readFile(path.join(stateDir, 'open-browser.pid')));
    if (original === undefined) delete process.env.OPEN_BROWSER_STATE_DIR;
    else process.env.OPEN_BROWSER_STATE_DIR = original;
    await rm(stateDir, { recursive: true, force: true });
  }
});
