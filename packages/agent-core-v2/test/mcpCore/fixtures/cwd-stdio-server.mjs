import { appendFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const startLog = process.env['KIMI_TEST_MCP_START_LOG'];
if (startLog !== undefined) appendFileSync(startLog, `${process.argv[2]} ${process.cwd()}\n`);

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
