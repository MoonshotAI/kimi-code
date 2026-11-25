import { appendFileSync } from 'node:fs';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

interface ToolSpec {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
  readonly reply?: string;
}

interface ServerSpec {
  readonly name: string;
  readonly tools: readonly ToolSpec[];
  readonly callLog?: string;
}

const spec = JSON.parse(process.argv[2] ?? '') as ServerSpec;
const mcp = new McpServer({ name: spec.name, version: '0.0.0' });
mcp.server.registerCapabilities({ tools: {} });

mcp.server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: spec.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object' as const, properties: {}, ...tool.inputSchema },
  })),
}));

mcp.server.setRequestHandler(CallToolRequestSchema, (request) => {
  const name = request.params.name;
  if (spec.callLog !== undefined) {
    appendFileSync(spec.callLog, `${JSON.stringify({ server: spec.name, tool: name, arguments: request.params.arguments ?? {} })}\n`);
  }
  const tool = spec.tools.find((candidate) => candidate.name === name);
  if (tool === undefined) return { isError: true, content: [{ type: 'text' as const, text: `The fake MCP server ${spec.name} has no tool ${name}` }] };
  return { content: [{ type: 'text' as const, text: tool.reply ?? `${name} done` }] };
});

await mcp.connect(new StdioServerTransport());
