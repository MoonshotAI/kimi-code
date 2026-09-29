export type McpManagementErrorCode =
  | 'mcp.server_not_found'
  | 'mcp.request_invalid'
  | 'mcp.config_invalid'
  | 'mcp.oauth_failed';

export class McpManagementError extends Error {
  readonly code: McpManagementErrorCode;

  constructor(code: McpManagementErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpManagementError';
    this.code = code;
  }
}
