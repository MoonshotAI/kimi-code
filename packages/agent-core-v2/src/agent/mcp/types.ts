/**
 * MCP protocol types and the minimal client contract `ToolManager` consumes.
 *
 * Lives in its own file (rather than `toolset.ts`) because the agent-side
 * tool-runtime layer is `ExecutableTool`, not the legacy `Toolset` interface.
 * What remains here is the wire-level surface: tool definitions returned by
 * `tools/list`, the `tools/call` result shape, and the small interface that
 * lets tests inject a fake transport without pulling in the MCP SDK type graph.
 */

/**
 * Inline resource contents nested under an EmbeddedResource block.
 * Exactly one of `text` or `blob` is populated, per the MCP schema's
 * `TextResourceContents | BlobResourceContents` union.
 */
export interface MCPEmbeddedResourceContents {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
  [key: string]: unknown;
}

export interface MCPContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  resource?: MCPEmbeddedResourceContents;
  [key: string]: unknown;
}

export interface MCPToolResult {
  content: MCPContentBlock[];
  isError: boolean;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface MCPClient {
  listTools(): Promise<MCPToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult>;
}

export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema === 'object' && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  throw new Error(`Invalid inputSchema for MCP tool "${toolName}": schema must be a JSON object`);
}
