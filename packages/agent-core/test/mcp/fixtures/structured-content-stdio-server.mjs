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
    description:
      'Returns the same JSON as a text block (pretty-printed, different key order) and as structuredContent',
    inputSchema: {},
  },
  () => ({
    content: [{ type: 'text', text: '{\n  "total": 1,\n  "rows": [ { "id": 1 } ]\n}' }],
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

server.registerTool(
  'faithful_rendering',
  {
    description: 'content is a faithful human rendering of structuredContent at similar size',
    inputSchema: {},
  },
  () => ({
    content: [
      {
        type: 'text',
        text: 'Project: Central Macaw [d594e625]\nDescription: none\nTimeline: 1920x1080 @ 30fps | durationInFrames=0\nAssets: total=0',
      },
    ],
    structuredContent: {
      project: { id: 'd594e625', name: 'Central Macaw', description: null },
      timeline: { width: 1920, height: 1080, fps: 30, durationInFrames: 0 },
      assets: { total: 0 },
    },
  }),
);

await server.connect(new StdioServerTransport());
