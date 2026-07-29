/**
 * `mcp` domain (L5) — registers the `mcp-channel` experimental flag into
 * `flag`.
 *
 * Gates `SessionMcpChannelBridgeImpl`'s subscription to the session's MCP
 * connection manager: an MCP server can push a message into a running
 * session (waking the main agent) instead of the agent polling for it. Off
 * by default; enable via `KIMI_CODE_EXPERIMENTAL_MCP_CHANNEL`, the master
 * `KIMI_CODE_EXPERIMENTAL_FLAG`, or the `[experimental]` config section.
 * Imported for its side effect from the package barrel.
 */

import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const MCP_CHANNEL_FLAG_ID = 'mcp-channel';
export const MCP_CHANNEL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_MCP_CHANNEL';

export const mcpChannelFlag: FlagDefinitionInput = {
  id: MCP_CHANNEL_FLAG_ID,
  title: 'MCP channel push',
  description:
    'Let an MCP server push a message into a running session (waking the main agent) instead of relying on the agent to poll for it.',
  env: MCP_CHANNEL_FLAG_ENV,
  default: false,
  surface: 'core',
};

registerFlagDefinition(mcpChannelFlag);
