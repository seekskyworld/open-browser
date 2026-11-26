#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { checkAgentRequest } from './contract-validation.mjs';
import { OpenBrowserClient, OpenBrowserError } from './sdk.mjs';

import { tools } from './api-contract.mjs';
const server = new Server({ name: 'open-browser', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  let args;
  try {
    const arguments_ = params.arguments ?? {};
    if (['createWorkspace', 'open'].includes(params.name) &&
        (typeof arguments_.name !== 'string' || !arguments_.name.trim()))
      throw new McpError(ErrorCode.InvalidParams, '创建 Agent 任务时必须提供非空任务名称 name。');
    args = checkAgentRequest(params.name, arguments_);
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw new McpError(ErrorCode.InvalidParams, 'Invalid open-browser tool name or arguments');
  }
  try {
    const client = server.getClientVersion();
    const clientName = client?.title?.trim() || client?.name?.trim() || 'MCP';
    const api = new OpenBrowserClient({ agentName: process.env.OPEN_BROWSER_AGENT_NAME?.trim() ||
      Array.from(clientName).slice(0, 80).join('') });
    const result = params.name === 'capabilities' ? await api.capabilities() : await api.call(params.name, args);
    if (params.name === 'captureVisual') {
      const {data,mimeType,...geometry}=result;
      return {content:[{type:'image',mimeType,data},{type:'text',text:JSON.stringify(geometry)}]};
    }
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    const detail = error instanceof OpenBrowserError
      ? { code: error.code, message: error.message, ...(error.nextAction ? { nextAction: error.nextAction } : {}) }
      : { code: 'CLIENT_ERROR', message: '本地服务调用失败。' };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify(detail) }] };
  }
});

await server.connect(new StdioServerTransport());
