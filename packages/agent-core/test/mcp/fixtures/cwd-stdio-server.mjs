// Minimal MCP stdio server fixture for cwd assertions.
// Exposes:
//   - get_cwd() -> the server process cwd

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'cwd-stdio', version: '0.0.1' });

server.registerTool(
  'get_cwd',
  {
    description: 'Returns the server process cwd',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: process.cwd() }],
  }),
);

await server.connect(new StdioServerTransport());
