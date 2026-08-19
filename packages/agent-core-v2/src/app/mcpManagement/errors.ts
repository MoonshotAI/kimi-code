import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const McpManagementErrors = {
  codes: {
    MCP_MANAGEMENT_DISABLED: 'mcp.management_disabled',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(McpManagementErrors);
