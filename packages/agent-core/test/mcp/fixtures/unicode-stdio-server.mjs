// MCP stdio server fixture that emits non-ASCII UTF-8 in its tool metadata
// and tool results. Used to regression-test that Kimi's stdio reader decodes
// protocol bytes as UTF-8 rather than the process locale text codec.
//
// The checkmark (U+2713 / "✓") is the exact character reported in
// https://github.com/MoonshotAI/kimi-code/issues/886.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'unicode-stdio', version: '0.0.1' });

server.registerTool(
  'unicode_echo',
  {
    description: 'Echoes input text with a Unicode checkmark ✓ prepended',
    inputSchema: { text: z.string() },
  },
  ({ text }) => ({
    content: [{ type: 'text', text: `✓ ${text}` }],
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
