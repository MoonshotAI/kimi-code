// MCP stdio server fixture covering structured-content result shapes, mirroring
// what real servers put on the wire (the Google Workspace servers dual-emit per
// the spec's backwards-compatibility SHOULD; others return structuredContent
// only).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'mock-structured-content', version: '0.0.1' });

server.registerTool(
  'dual_emit',
  {
    description: 'Returns the same JSON as a text block and as structuredContent',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: '{"rows":[{"id":1}],"total":1}' }],
    structuredContent: { rows: [{ id: 1 }], total: 1 },
  }),
);

server.registerTool(
  'structured_only',
  {
    description: 'Returns structuredContent without any text content',
    inputSchema: {},
  },
  () => ({
    structuredContent: { rows: [{ id: 1 }], total: 1 },
  }),
);

server.registerTool(
  'prose_plus_structured',
  {
    description: 'Returns a prose summary in content plus distinct structuredContent',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: 'Found 1 row.' }],
    structuredContent: { rows: [{ id: 1 }], total: 1 },
  }),
);

server.registerTool(
  'meta_vendor',
  {
    description: 'Returns text content plus a vendor-namespaced _meta key',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: 'done' }],
    _meta: { 'example.com/trace': 'abc123' },
  }),
);

await server.connect(new StdioServerTransport());
