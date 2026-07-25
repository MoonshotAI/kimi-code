/**
 * `mcp` domain (L5) — registers MCP timeout preferences into `config`.
 *
 * Owns the global MCP startup and tool-call timeout preferences, including
 * their environment bindings and persistence guard. Registered into `config`
 * at module load. Bound at App scope.
 */

import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { MAX_MCP_TIMEOUT_MS, McpTimeoutMsSchema } from './config-schema';

export const MCP_SECTION = 'mcp';

export const McpSectionSchema = z.object({
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
});

export type McpSection = z.infer<typeof McpSectionSchema>;

export const MCP_STARTUP_TIMEOUT_ENV = 'KIMI_MCP_STARTUP_TIMEOUT_MS';
export const MCP_TOOL_TIMEOUT_ENV = 'KIMI_MCP_TOOL_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_MCP_TIMEOUT_MS
    ? parsed
    : undefined;
}

export const mcpEnvBindings: EnvBindings<McpSection> = envBindings(McpSectionSchema, {
  startupTimeoutMs: { env: MCP_STARTUP_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  toolTimeoutMs: { env: MCP_TOOL_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
});

export const stripMcpEnv = stripEnvBoundFields(mcpEnvBindings);

registerConfigSection(MCP_SECTION, McpSectionSchema, {
  env: mcpEnvBindings,
  stripEnv: stripMcpEnv,
});
