// MCP stdio server fixture that spawns a long-lived grandchild process.
// Used to verify that StdioMcpClient.close() reaps the whole process tree,
// not just the immediate child spawned by the SDK transport.

import { spawn } from 'node:child_process';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// Spawn a grandchild that sleeps forever and ignores SIGTERM so the test can
// distinguish "transport killed immediate child" from "whole tree killed".
const grandchild = spawn(
  process.execPath,
  ['-e', 'setInterval(() => {}, 1 << 30); process.on("SIGTERM", () => {});'],
  {
    detached: false,
    stdio: 'ignore',
  },
);

const server = new McpServer({ name: 'grandchild-stdio', version: '0.0.1' });

server.registerTool(
  'get_grandchild_pid',
  {
    description: 'Returns the PID of the long-lived grandchild',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: String(grandchild.pid) }],
  }),
);

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
