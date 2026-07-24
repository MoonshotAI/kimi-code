import { setTimeout as sleep } from 'node:timers/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const delayMs = Number.parseInt(process.env['KIMI_TEST_MCP_TOOL_DELAY_MS'] ?? '2000', 10);

const server = new McpServer({ name: 'slow-tool-stdio', version: '0.0.1' });

server.registerTool(
  'slow_echo',
  {
    description: 'Echoes input text after a delay',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => {
    await sleep(delayMs);
    return { content: [{ type: 'text', text }] };
  },
);

await server.connect(new StdioServerTransport());
