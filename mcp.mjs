#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp-server.mjs';
const server = createMcpServer();
await server.connect(new StdioServerTransport());
