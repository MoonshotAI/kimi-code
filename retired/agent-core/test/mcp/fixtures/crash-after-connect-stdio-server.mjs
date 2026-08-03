// Simulates an MCP stdio server that connects normally and then exits a short
// time later, without going through the protocol shutdown handshake. Used to
// drive the "transport disconnected after connect" path in
// McpConnectionManager.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'crash-after-connect', version: '0.0.1' });

const exitCode = Number.parseInt(process.env['KIMI_TEST_MCP_EXIT_CODE'] ?? '1', 10);
const stderrBanner = process.env['KIMI_TEST_MCP_STDERR'];

function exitWithBanner() {
  if (stderrBanner !== undefined) {
    process.stderr.write(`${stderrBanner}\n`);
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

// Returns a normal reply, then exits on the next macrotask so the response is
// fully flushed to stdout before the pipe closes. Lets a test deterministically
// trigger "post-handshake disconnect" without racing against startup timing.
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

const exitAfterMsRaw = process.env['KIMI_TEST_MCP_EXIT_AFTER_MS'];
if (exitAfterMsRaw !== undefined) {
  setTimeout(exitWithBanner, Number.parseInt(exitAfterMsRaw, 10));
}
