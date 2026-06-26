/**
 * `mcp` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const McpErrors = {
  codes: {
    MCP_SERVER_NOT_FOUND: 'mcp.server_not_found',
    MCP_SERVER_DISABLED: 'mcp.server_disabled',
    MCP_STARTUP_FAILED: 'mcp.startup_failed',
    MCP_TOOL_NAME_COLLISION: 'mcp.tool_name_collision',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(McpErrors);
