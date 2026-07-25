/**
 * Shared MCP server wire schema for session creation and plugin manifests.
 * Mirrors `agent-core-v2/agent/mcp/config-schema.ts`.
 */

import { z } from 'zod';

const stringRecordSchema = z.record(z.string(), z.string());

export const mcpTimeoutMsSchema = z.number().int().min(1).max(2_147_483_647);

const mcpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: mcpTimeoutMsSchema.optional(),
  toolTimeoutMs: mcpTimeoutMsSchema.optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

export const mcpServerConfigSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: stringRecordSchema.optional(),
    cwd: z.string().optional(),
    executor: z.enum(['local', 'kaos']).optional(),
    ...mcpServerCommonFields,
  }),
  z.object({
    transport: z.literal('http'),
    url: z.string().url(),
    headers: stringRecordSchema.optional(),
    bearerTokenEnvVar: z.string().min(1).optional(),
    ...mcpServerCommonFields,
  }),
  z.object({
    transport: z.literal('sse'),
    url: z.string().url(),
    headers: stringRecordSchema.optional(),
    bearerTokenEnvVar: z.string().min(1).optional(),
    ...mcpServerCommonFields,
  }),
]);
