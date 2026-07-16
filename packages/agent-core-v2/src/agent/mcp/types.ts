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
  connect(signal?: AbortSignal): Promise<void>;
  listTools(signal?: AbortSignal): Promise<MCPToolDefinition[]>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<MCPToolResult>;
}

/**
 * Validate an MCP server-supplied `inputSchema` before it is forwarded
 * to the LLM provider as a tool-call parameter definition.
 *
 * MCP tools are external inputs — a buggy or malicious server could
 * send a malformed schema that breaks downstream JSON Schema parsing
 * or exploits parser edge cases. We require the schema to be a JSON
 * object whose `type` (if present) is ``object``; arrays/primitives
 * are rejected because tool parameters are always objects.
 */
export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema !== 'object' || inputSchema === null || Array.isArray(inputSchema)) {
    throw new Error(`Invalid inputSchema for MCP tool "${toolName}": schema must be a JSON object`);
  }
  const schema = inputSchema as Record<string, unknown>;
  const type = schema['type'];
  if (type !== undefined) {
    // Allow `type` to be a string ("object") or an array containing "object".
    const isObjectType =
      type === 'object' ||
      (Array.isArray(type) && type.every((t) => typeof t === 'string') && type.includes('object'));
    if (!isObjectType) {
      throw new Error(
        `Invalid inputSchema for MCP tool "${toolName}": \`type\` must be "object" when present, got ${JSON.stringify(type)}`,
      );
    }
  }
  // Reject schemas that look like JSON-schema but declare an unrelated
  // draft that downstream parsers may not understand.
  const schemaUri = schema['$schema'];
  if (typeof schemaUri === 'string' && schemaUri.length > 0) {
    const allowed = /^https?:\/\/json-schema\.org\/draft-(0[4-9]|2020-12)\/schema#?$/i;
    if (!allowed.test(schemaUri)) {
      throw new Error(
        `Invalid inputSchema for MCP tool "${toolName}": unsupported $schema "${schemaUri}"`,
      );
    }
  }
  return schema;
}
