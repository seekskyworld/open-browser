import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { agentMethods, OpenBrowserClient, OpenBrowserError, recoveryHints } from './sdk.mjs';

const projectDir = fileURLToPath(new URL('./', import.meta.url));

async function runCli(method, params, env) {
  const child = spawn(process.execPath, [path.join(projectDir, 'cli.mjs'), method], { env });
  const done = once(child, 'close');
  child.stdin.end(JSON.stringify(params));
  let output = '';
  let errors = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; });
  return { status: (await done)[0], output, errors };
}

test('SDK, CLI and stdio MCP share the authenticated API and isolate host controls', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ob-client-'));
  const env = { ...process.env, OPEN_BROWSER_STATE_DIR: dir };
  const locations = JSON.parse(execFileSync(process.execPath, [
    '--input-type=module', '-e',
    "import {socketPath,tokenPath} from './paths.mjs';console.log(JSON.stringify({socketPath,tokenPath}));",
  ], { cwd: projectDir, env, encoding: 'utf8' }));
  const calls = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/v1/call');
    assert.equal(req.method, 'POST');
    assert.equal(req.headers.authorization, 'Bearer test-agent');
    let body = '';
    for await (const chunk of req) body += chunk;
    const call = JSON.parse(body);
    calls.push(call);
    const reply = call.method === 'getOperation'
      ? { error: { code: 'NOT_FOUND', message: '找不到此操作。' } }
      : { result: { echo: call } };
    res.writeHead(reply.error ? 404 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
  const mcp = new Client({ name: 'open-browser-test', title: '核验助手', version: '0.1.0' });
  try {
    await mkdir(path.dirname(locations.tokenPath), { recursive: true });
    await writeFile(locations.tokenPath, 'test-agent\n', { mode: 0o600 });
    server.listen(locations.socketPath);
    await once(server, 'listening');
    const sdk = new OpenBrowserClient(locations);
    const handle = { workspaceId: 'workspace', pageId: 'page' };
    const sdkResult = await sdk.observe(handle);
    const cliResult = await runCli('observe', handle, env);
    assert.equal(cliResult.status, 0, cliResult.errors);
    assert.deepEqual(JSON.parse(cliResult.output), sdkResult);

    await mcp.connect(new StdioClientTransport({
      command: process.execPath, args: [path.join(projectDir, 'mcp.mjs')],
      env: { OPEN_BROWSER_STATE_DIR: dir },
    }));
    const listing = await mcp.listTools();
    assert.deepEqual(listing.tools.map(tool => tool.name), agentMethods);
    const observed = await mcp.callTool({ name: 'observe', arguments: handle });
    assert.deepEqual(JSON.parse(observed.content[0].text), sdkResult);
    assert.equal(calls.length, 3);

    for (const name of ['setCredential', 'takeControl', 'returnToAgent', 'keepDownload']) {
      assert.ok(!agentMethods.includes(name));
      await assert.rejects(sdk.call(name), { code: 'UNKNOWN_METHOD' });
      await assert.rejects(mcp.callTool({ name, arguments: {} }));
      assert.equal((await runCli(name, {}, env)).status, 1);
    }
    await assert.rejects(mcp.callTool({ name: 'observe', arguments: { workspaceId: 'missingPage' } }));
    assert.equal(calls.length, 3, 'forbidden clients and invalid tools must not reach the local API');

    const filtered = {...handle, name:'Export', limit:20, frameControls:true,
      region:{x:0,y:0,width:400,height:300}};
    for (const [method, args] of [
      ['observe', filtered], ['observe', {...handle, cursor:'next'}],
      ['listDownloads', {workspaceId:handle.workspaceId}],
      ['cancelDownload', {workspaceId:handle.workspaceId, downloadId:'file'}],
    ]) {
      const expected = await sdk.call(method, args);
      assert.deepEqual(JSON.parse((await runCli(method, args, env)).output), expected);
      const result = await mcp.callTool({name:method, arguments:args});
      assert.deepEqual(JSON.parse(result.content[0].text), expected);
    }

    const cliEnv = { ...env };
    for (const key of ['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'OPEN_BROWSER_AGENT_NAME']) delete cliEnv[key];
    const origins = ['https://example.org'];
    for (const [params, settings, expected] of [
      [{ name: 'CLI 任务' }, {}, 'CLI'],
      [{ name: 'Codex 任务' }, { CODEX_THREAD_ID: 'thread' }, 'Codex'],
      [{ name: '会话任务' }, { CODEX_SESSION_ID: 'session', OPEN_BROWSER_AGENT_NAME: '配置助手' }, '配置助手'],
      [{ name: '检查', allowedOrigins: origins, agentName: '子代理' }, { OPEN_BROWSER_AGENT_NAME: '配置助手' }, '子代理'],
    ]) {
      const created = await runCli('createWorkspace', params, { ...cliEnv, ...settings });
      assert.equal(created.status, 0, created.errors);
      assert.deepEqual(JSON.parse(created.output).echo.params, { ...params, agentName: expected });
    }
    const namedSdk = new OpenBrowserClient({ ...locations, agentName: 'SDK 调用方' });
    await assert.rejects(namedSdk.createWorkspace(), { code: 'TASK_NAME_REQUIRED' });
    assert.equal((await namedSdk.createWorkspace({name:'SDK 任务'})).echo.params.agentName, 'SDK 调用方');
    assert.equal((await namedSdk.call('createWorkspace', { name: '测试任务', agentName: 'SDK 子代理' })).echo.params.agentName, 'SDK 子代理');
    const inferred = await mcp.callTool({ name: 'createWorkspace', arguments: { name: 'MCP 任务' } });
    assert.equal(JSON.parse(inferred.content[0].text).echo.params.agentName, '核验助手');
    const options = { agentName: 'MCP 子代理', name: '测试', allowedOrigins: origins };
    const selected = await mcp.callTool({ name: 'createWorkspace', arguments: options });
    assert.deepEqual(JSON.parse(selected.content[0].text).echo.params, options);
    await assert.rejects(mcp.callTool({ name: 'createWorkspace', arguments: { agentName: 34 } }));

    const fallbackMcp = new Client({ name: 'integration-client', version: '1.0.0' });
    try {
      await fallbackMcp.connect(new StdioClientTransport({
        command: process.execPath, args: [path.join(projectDir, 'mcp.mjs')], env: { OPEN_BROWSER_STATE_DIR: dir },
      }));
      const result = await fallbackMcp.callTool({ name: 'createWorkspace', arguments: { name: '回退任务' } });
      assert.equal(JSON.parse(result.content[0].text).echo.params.agentName, 'integration-client');
    } finally { await fallbackMcp.close(); }

    const params = {
      ...handle, documentId: 'doc', controlGeneration: 'lease', operationId: 'op',
      actions: [{ kind: 'fillCredential', ref: 'r1', credentialRef: 'account' }],
    };
    const submitted = await mcp.callTool({ name: 'act', arguments: params });
    assert.deepEqual(JSON.parse(submitted.content[0].text).echo, { method: 'act', params });
    const failed = await mcp.callTool({ name: 'getOperation', arguments: { workspaceId: 'workspace', operationId: 'missing' } });
    assert.equal(failed.isError, true);
    assert.equal(JSON.parse(failed.content[0].text).code, 'NOT_FOUND');
    const cliFailure = await runCli('getOperation', { workspaceId: 'workspace', operationId: 'missing' }, env);
    assert.equal(cliFailure.status, 1);
    assert.equal(JSON.parse(cliFailure.errors).error.code, 'NOT_FOUND');
  } finally {
    await mcp.close();
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test('capability discovery falls back on a legacy server and leaves unavailable service errors visible',async()=>{
  const sdk=new OpenBrowserClient();
  for(const code of ['unknown_method','forbidden']) {
    sdk.call=async()=>{throw Object.assign(new Error(code),{code});};
    assert.deepEqual(await sdk.capabilities(),{version:0,visual:{enabled:false,actions:[]}});
  }
  sdk.call=async()=>{throw Object.assign(new Error('offline'),{code:'SERVICE_UNAVAILABLE'});};
  await assert.rejects(sdk.capabilities(),{code:'SERVICE_UNAVAILABLE'});
});

test('SDK convenience helpers keep fresh observation metadata and idempotent finish IDs', async () => {
  const api = new OpenBrowserClient({ socketPath: 'unused', tokenPath: 'unused' });
  const page = { workspaceId: 'workspace', pageId: 'page' };
  api.open = async options => ({ ...page, url: options.url });
  api.observe = async handle => ({ ...handle, documentId: 'doc-2', controlGeneration: 'generation-2', text: 'Ready' });
  let submitted;
  api.act = async (handle, request) => { submitted = { handle, request }; return { operationId: request.operationId, state: 'completed' }; };
  api.observeAndAct = async (handle, request) => {
    const observation = await api.observe(handle);
    const receipt = await api.act({ ...handle, documentId: observation.documentId,
      controlGeneration: observation.controlGeneration }, {
        ...request,
        operationId: request.operationId ?? '00000000-0000-4000-8000-000000000000',
      });
    return { observation, receipt };
  };
  const opened = await api.openAndObserve({ url: 'https://example.org' });
  assert.equal(opened.observation.documentId, 'doc-2');
  const acted = await api.actAfterObserve(page, { actions: [{ kind: 'click', ref: 'button-1' }] });
  assert.equal(submitted.handle.documentId, 'doc-2');
  assert.equal(submitted.handle.controlGeneration, 'generation-2');
  assert.match(submitted.request.operationId, /^[0-9a-f-]{36}$/);
  assert.equal(acted.receipt.state, 'completed');
  let finishArgs;
  api.finishWorkspace = async (...args) => { finishArgs = args; return { state: 'completed' }; };
  await api.finish('workspace', ['page']);
  assert.deepEqual(finishArgs.slice(0, 2), ['workspace', ['page']]);
  assert.match(finishArgs[2], /^[0-9a-f-]{36}$/);
  const error = new OpenBrowserError('stale_ref', 'stale');
  assert.equal(error.nextAction, recoveryHints.stale_ref);
});
