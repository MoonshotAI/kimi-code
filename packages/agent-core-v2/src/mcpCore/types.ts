import { ErrorCodes, Error2 } from '#/errors';

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
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
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
  ping(signal?: AbortSignal): Promise<void>;
}

export function assertMcpInputSchema(
  toolName: string,
  inputSchema: unknown,
): Record<string, unknown> {
  if (typeof inputSchema === 'object' && inputSchema !== null && !Array.isArray(inputSchema)) {
    const schema = inputSchema as Record<string, unknown>;
    sanitizeMcpSchemaRegex(schema);
    return schema;
  }
  throw new Error2(
    ErrorCodes.MCP_STARTUP_FAILED,
    `Invalid inputSchema for MCP tool "${toolName}": schema must be a JSON object`,
  );
}

function sanitizeMcpSchemaRegex(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) sanitizeMcpSchemaRegex(item);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as Record<string, unknown>;
  if ('regex' in obj) {
    const regexValue = obj['regex'];
    if (typeof regexValue === 'string' && !('pattern' in obj)) {
      obj['pattern'] = regexValue;
    }
    delete obj['regex'];
  }
  for (const value of Object.values(obj)) {
    sanitizeMcpSchemaRegex(value);
  }
}
