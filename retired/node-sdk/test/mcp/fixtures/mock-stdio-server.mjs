// Minimal MCP stdio server fixture for StdioMcpClient tests.
// Exposes:
//   - echo(text: string) -> text content
//   - boom() -> isError: true
//   - read_env(name: string) -> the value of process.env[name] (used to assert
//     that StdioClientTransport `env` is honoured)

import { setTimeout as sleep } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const delayMs = Number.parseInt(process.env['KIMI_TEST_MCP_START_DELAY_MS'] ?? '0', 10);
if (delayMs > 0) {
  await sleep(delayMs);
}

const server = new McpServer({ name: 'mock-stdio', version: '0.0.1' });

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

server.registerTool(
  'boom',
  {
    description: 'Always returns an error result',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: 'boom!' }],
    isError: true,
  }),
);

server.registerTool(
  'read_env',
  {
    description: 'Returns the value of process.env[name], or empty string',
    inputSchema: { name: z.string() },
  },
  ({ name }) => ({
    content: [{ type: 'text', text: process.env[name] ?? '' }],
  }),
);

await server.connect(new StdioServerTransport());
