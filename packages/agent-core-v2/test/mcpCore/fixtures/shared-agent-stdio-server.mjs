import { spawn } from 'node:child_process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'shared-agent', version: '0.0.1' });

server.registerTool(
  'spawn_agent',
  {
    description: 'Starts a long-lived agent child process and returns its pid',
    inputSchema: {},
  },
  () => {
    const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    agent.unref();
    return { content: [{ type: 'text', text: String(agent.pid) }] };
  },
);

if (process.env['KIMI_TEST_MCP_IGNORE_EOF'] === '1') {
  setInterval(() => {}, 1000);
} else {
  process.stdin.on('end', () => process.exit(0));
}

await server.connect(new StdioServerTransport());
