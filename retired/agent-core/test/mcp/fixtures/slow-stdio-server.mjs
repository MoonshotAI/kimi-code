// Simulates a slow-starting MCP server: sleeps before completing the
// initialize handshake so startupTimeoutMs in McpConnectionManager fires.

import { setTimeout as sleep } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const delayMs = Number.parseInt(process.env['KIMI_TEST_MCP_START_DELAY_MS'] ?? '2000', 10);
await sleep(delayMs);

const server = new McpServer({ name: 'slow-stdio', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'Echoes input text',
    inputSchema: { text: z.string() },
  },
  ({ text }) => ({
    content: [{ type: 'text', text }],
  }),
);

await server.connect(new StdioServerTransport());
