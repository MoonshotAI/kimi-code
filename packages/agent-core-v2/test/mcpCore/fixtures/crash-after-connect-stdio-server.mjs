import { existsSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'crash-after-connect', version: '0.0.1' });

const exitCode = Number.parseInt(process.env['KIMI_TEST_MCP_EXIT_CODE'] ?? '1', 10);
const stderrBanner = process.env['KIMI_TEST_MCP_STDERR'];

function exitWithBanner() {
  if (stderrBanner !== undefined) {
    process.stderr.write(`${stderrBanner}\n`, () => process.exit(exitCode));
    return;
  }
  process.exit(exitCode);
}

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
  'exit_after_reply',
  {
    description: 'Replies, then exits the process',
    inputSchema: {},
  },
  () => {
    setImmediate(exitWithBanner);
    return { content: [{ type: 'text', text: 'bye' }] };
  },
);

await server.connect(new StdioServerTransport());

const exitSignalFile = process.env['KIMI_TEST_MCP_EXIT_WHEN_FILE'];
if (exitSignalFile !== undefined) {
  const poll = setInterval(() => {
    if (!existsSync(exitSignalFile)) return;
    clearInterval(poll);
    exitWithBanner();
  }, 10);
}
