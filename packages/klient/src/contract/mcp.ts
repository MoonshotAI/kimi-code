/**
 * Shared MCP server wire schema for session creation and plugin manifests.
 * Mirrors `agent-core-v2/mcpCore/config-schema.ts`. Unlike the config files,
 * the wire requires the explicit `transport` discriminant (the engine's
 * command/url inference preprocess is a file-format convenience).
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

export const mcpServerStdioConfigSchema = z.object({
  transport: z.literal('stdio'),
  runtime_id: z.string().min(1).optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringRecordSchema.optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  ...mcpServerCommonFields,
});

export const mcpServerHttpConfigSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: stringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...mcpServerCommonFields,
});

export const mcpServerSseConfigSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: stringRecordSchema.optional(),
  auth: z.literal('oauth').optional(),
  bearerTokenEnvVar: z.string().min(1).optional(),
  ...mcpServerCommonFields,
});

export const mcpServerConfigSchema = z.discriminatedUnion('transport', [
  mcpServerStdioConfigSchema,
  mcpServerHttpConfigSchema,
  mcpServerSseConfigSchema,
]);

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
