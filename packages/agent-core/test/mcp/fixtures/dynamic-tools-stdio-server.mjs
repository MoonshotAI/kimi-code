// MCP stdio server fixture that changes its visible tool list at runtime.
// Initially exposes enable_extra_tool; calling it enables dynamic_echo and
// emits notifications/tools/list_changed through the SDK.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'dynamic-tools-stdio', version: '0.0.1' });

let dynamicEchoTool;

server.registerTool(
  'enable_extra_tool',
  {
    description: 'Enables the dynamic echo tool',
    inputSchema: {},
  },
  () => {
    dynamicEchoTool.enable();
    return { content: [{ type: 'text', text: 'enabled' }] };
  },
);

dynamicEchoTool = server.registerTool(
  'dynamic_echo',
  {
    description: 'Echoes input text after being enabled',
    inputSchema: { text: z.string() },
  },
  ({ text }) => ({
    content: [{ type: 'text', text }],
  }),
);
dynamicEchoTool.disable();

await server.connect(new StdioServerTransport());
