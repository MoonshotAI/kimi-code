import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const mcpManagementFlag: FlagDefinitionInput = {
  id: 'mcp_management',
  title: 'MCP management plane',
  description:
    'Unified MCP server management (registry view, CRUD, connection test) backed by agent-core-v2',
  env: 'KIMI_CODE_EXPERIMENTAL_MCP_MANAGEMENT',
  default: false,
  surface: 'core',
};

registerFlagDefinition(mcpManagementFlag);
