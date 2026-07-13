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

/**
 * A content block as returned by an MCP tool call (`tools/call`).
 *
 * This is a structural subset of the MCP protocol `ContentBlock` union,
 * covering the shapes that {@link convertMCPContentBlock} knows how to convert
 * into kosong `ContentPart`s. Additional fields are ignored.
 */
export interface MCPContentBlock {
  // Known values: 'text' | 'image' | 'audio' | 'resource' | 'resource_link'.
  // Declared as `string` to also accept future MCP content types without a
  // type assertion.
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  // EmbeddedResource carries its payload nested under `resource`, per the
  // MCP spec — never as top-level `data`/`mimeType`.
  resource?: MCPEmbeddedResourceContents;
  [key: string]: unknown;
}

/**
 * Result of a single MCP tool invocation.
 *
 * Matches the shape returned by the MCP protocol's `tools/call` method.
 */
export interface MCPToolResult {
  content: MCPContentBlock[];
  isError: boolean;
}

/**
 * An MCP tool definition as returned by an MCP server's `tools/list` method.
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
}

/**
 * Minimal MCP client interface consumed by {@link McpConnectionManager} and
 * {@link ToolManager}.
 *
 * This is a transport-agnostic seam: implementations can wrap
 * `@modelcontextprotocol/sdk`, a bespoke stdio client, an HTTP SSE client,
 * or a mock for testing. Keeping the surface small lets tests inject fakes
 * without pulling in the full SDK type graph.
 */
export interface MCPClient {
  /** List the tools advertised by the MCP server. */
  listTools(): Promise<MCPToolDefinition[]>;
  /**
   * Invoke a tool by name with the given JSON arguments.
   *
   * `signal`, when provided, is forwarded to the underlying transport so an
   * abort from the loop (e.g. user cancellation) propagates all the way to
   * the server instead of leaving the request running in the background.
   */
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult>;
}

/**
 * Validate the `inputSchema` field of an MCP tool definition. MCP advertises
 * input schemas as JSON Schema objects; reject anything that is not a plain
 * object so the validator compiler downstream never sees `null` or a
 * primitive.
 */
export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema === 'object' && inputSchema !== null && !Array.isArray(inputSchema)) {
    return inputSchema as Record<string, unknown>;
  }
  throw new Error(`Invalid inputSchema for MCP tool "${toolName}": schema must be a JSON object`);
}
