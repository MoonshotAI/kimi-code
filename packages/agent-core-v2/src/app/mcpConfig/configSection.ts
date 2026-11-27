import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { MAX_MCP_TIMEOUT_MS, McpTimeoutMsSchema } from '#/mcpCore/config-schema';

export const MCP_SECTION = 'mcp';
export const DEFAULT_MCP_STARTUP_WAIT_MS = 2_000;

const McpWaitMsSchema = z.number().int().min(0).max(MAX_MCP_TIMEOUT_MS);

export const McpSectionSchema = z.object({
  startupTimeoutMs: McpTimeoutMsSchema.optional(),
  startupWaitMs: McpWaitMsSchema.optional(),
  toolTimeoutMs: McpTimeoutMsSchema.optional(),
  defaultDeferred: z.boolean().optional(),
  reconnectInitialDelayMs: McpTimeoutMsSchema.optional(),
  reconnectMaxDelayMs: McpTimeoutMsSchema.optional(),
});

export type McpSection = z.infer<typeof McpSectionSchema>;

export interface McpTunables {
  readonly startupTimeoutMs?: number;
  readonly startupWaitMs?: number;
  readonly toolTimeoutMs?: number;
  readonly defaultDeferred?: boolean;
  readonly reconnectInitialDelayMs?: number;
  readonly reconnectMaxDelayMs?: number;
}

export function mcpTunablesFromSection(section: McpSection | undefined): McpTunables {
  return {
    startupTimeoutMs: section?.startupTimeoutMs,
    startupWaitMs: section?.startupWaitMs,
    toolTimeoutMs: section?.toolTimeoutMs,
    defaultDeferred: section?.defaultDeferred,
    reconnectInitialDelayMs: section?.reconnectInitialDelayMs,
    reconnectMaxDelayMs: section?.reconnectMaxDelayMs,
  };
}

export const MCP_STARTUP_TIMEOUT_ENV = 'KIMI_MCP_STARTUP_TIMEOUT_MS';
export const MCP_STARTUP_WAIT_ENV = 'KIMI_MCP_STARTUP_WAIT_MS';
export const MCP_TOOL_TIMEOUT_ENV = 'KIMI_MCP_TOOL_TIMEOUT_MS';
export const MCP_RECONNECT_INITIAL_DELAY_ENV = 'KIMI_MCP_RECONNECT_INITIAL_DELAY_MS';
export const MCP_RECONNECT_MAX_DELAY_ENV = 'KIMI_MCP_RECONNECT_MAX_DELAY_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_MCP_TIMEOUT_MS
    ? parsed
    : undefined;
}

function parseWaitMsEnv(raw: string): number | undefined {
  if (raw.trim() === '') return undefined;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= MAX_MCP_TIMEOUT_MS
    ? parsed
    : undefined;
}

export const mcpEnvBindings: EnvBindings<McpSection> = envBindings(McpSectionSchema, {
  startupTimeoutMs: { env: MCP_STARTUP_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  startupWaitMs: { env: MCP_STARTUP_WAIT_ENV, parse: parseWaitMsEnv },
  toolTimeoutMs: { env: MCP_TOOL_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  reconnectInitialDelayMs: { env: MCP_RECONNECT_INITIAL_DELAY_ENV, parse: parseTimeoutMsEnv },
  reconnectMaxDelayMs: { env: MCP_RECONNECT_MAX_DELAY_ENV, parse: parseTimeoutMsEnv },
});

export const stripMcpEnv = stripEnvBoundFields(mcpEnvBindings);

registerConfigSection(MCP_SECTION, McpSectionSchema, {
  env: mcpEnvBindings,
  stripEnv: stripMcpEnv,
});
