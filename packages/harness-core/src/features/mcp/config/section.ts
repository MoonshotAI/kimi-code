import { z } from 'zod';

import type { ConfigSectionContribution } from '@moonshot-ai/agent-core';

import { MAX_MCP_TIMEOUT_MS, McpTimeoutMsSchema } from '#/features/mcp/core/config-schema';

export const MCP_CONFIG_SECTION = 'mcp';

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

export const mcpConfigSection: ConfigSectionContribution<McpSection> = {
  name: MCP_CONFIG_SECTION,
  schema: McpSectionSchema,
  defaultValue: {},
  envBindings: {
    startupTimeoutMs: { env: MCP_STARTUP_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
    toolTimeoutMs: { env: MCP_TOOL_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
  },
  stripEnv: (value) => {
    const out = { ...value };
    delete out.startupTimeoutMs;
    delete out.toolTimeoutMs;
    return out;
  },
};
