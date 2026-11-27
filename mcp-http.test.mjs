import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { agentMethods } from './sdk.mjs';

test('loopback MCP HTTP requires the profile token and exposes the stdio tools', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'open-browser-mcp-http-'));
  const port = 19400 + Math.floor(Math.random() * 500);
  const env = { ...process.env, OPEN_BROWSER_STATE_DIR: state, OPEN_BROWSER_MCP_HTTP_PORT: String(port) };
  const tokenDir = path.join(state);
  await mkdir(tokenDir, { recursive: true });
  await writeFile(path.join(tokenDir, 'open-browser.token'), 'test-token\n', { mode: 0o600 });
  const child = spawn(process.execPath, ['mcp-http.mjs'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    for (let i = 0; i < 100; i++) {
      try {
        const response = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
        if (response.status === 401) break;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const unauthorized = await fetch(url, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(unauthorized.status, 401, stderr);
    const client = new Client({ name: 'open-browser-http-test', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: 'Bearer test-token' } },
    });
    try {
      await client.connect(transport);
      const listing = await client.listTools();
      assert.deepEqual(listing.tools.map(tool => tool.name), agentMethods);
    } finally {
      await client.close().catch(() => {});
    }
  } finally {
    child.kill('SIGTERM');
    await once(child, 'close').catch(() => {});
    await rm(state, { recursive: true, force: true });
  }
});
