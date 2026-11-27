#!/usr/bin/env node
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from './mcp-server.mjs';
import { tokenPath } from './paths.mjs';

const host = process.env.OPEN_BROWSER_MCP_HTTP_HOST || '127.0.0.1';
const port = Number(process.env.OPEN_BROWSER_MCP_HTTP_PORT || 9239);
if (!['127.0.0.1', '::1'].includes(host)) throw new Error('MCP HTTP 只允许绑定回环地址。');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('OPEN_BROWSER_MCP_HTTP_PORT 无效。');

async function readToken() {
  const configured = process.env.OPEN_BROWSER_MCP_HTTP_TOKEN?.trim();
  if (configured) return configured;
  try { return (await readFile(tokenPath, 'utf8')).trim(); } catch { return ''; }
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  if (!Buffer.concat(chunks).length) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const sessions = new Map();
const server = createServer(async (req, res) => {
  if (req.url !== '/mcp') { res.writeHead(404).end(); return; }
  const token = await readToken();
  const authorization = req.headers.authorization || '';
  if (!token || authorization !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const sessionId = req.headers['mcp-session-id'];
  if (req.method === 'DELETE') {
    const session = sessions.get(sessionId);
    if (!session) { res.writeHead(404).end(); return; }
    sessions.delete(sessionId);
    await session.transport.close().catch(() => {});
    await session.mcp.close().catch(() => {});
    res.writeHead(204).end();
    return;
  }
  if (!['POST', 'GET'].includes(req.method)) { res.writeHead(405, { allow: 'GET, POST, DELETE' }).end(); return; }
  let body;
  try { body = req.method === 'POST' ? await readBody(req) : undefined; } catch {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_json' }));
    return;
  }
  let session = sessionId ? sessions.get(sessionId) : undefined;
  if (!session) {
    if (req.method !== 'POST' || !isInitializeRequest(body)) {
      res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'initialize_required' }));
      return;
    }
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    session = { mcp, transport };
    transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
    await mcp.connect(transport);
  }
  try {
    await session.transport.handleRequest(req, res, body);
    if (session.transport.sessionId) sessions.set(session.transport.sessionId, session);
  } catch (error) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'mcp_server_error' }));
  }
});

server.listen(port, host, () => console.error(`open-browser MCP HTTP listening on http://${host}:${port}/mcp`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  void Promise.all([...sessions.values()].map(async session => {
    await session.transport.close().catch(() => {});
    await session.mcp.close().catch(() => {});
  })).finally(() => server.close(() => process.exit(0)));
});
