/**
 * `/mcp/config/servers` REST wire schemas — user-level `mcp.json` management.
 *
 *   GET    /mcp/config/servers                data: { servers: Record<name, WireMcpServerConfig> }
 *   POST   /mcp/config/servers/{name}         body: WireMcpServerConfig  → upsert
 *   DELETE /mcp/config/servers/{name}         → remove
 *
 * The wire shape is the snake_case rendering of `McpServerConfig`
 * (`packages/agent-core-v2/src/mcpCore/config-schema.ts`): the route layer
 * converts between this wire form and the camelCase JSON stored on disk in
 * `<kimi-home>/mcp.json` (`{ "mcpServers": { name: McpServerConfig } }`).
 *
 * The wire schema mirrors the on-disk schema's preprocess sugar: a payload
 * without `transport` is normalized — `command` → `stdio`, `url` → `http` —
 * before discriminated-union validation, so callers may omit `transport` for
 * the common stdio case.
 */

import { z } from 'zod';

const MAX_MCP_TIMEOUT_MS = 2_147_483_647;
const mcpTimeoutMsWire = z.number().int().min(1).max(MAX_MCP_TIMEOUT_MS);
const stringRecordWire = z.record(z.string(), z.string());

const mcpServerCommonWireFields = {
  enabled: z.boolean().optional(),
  startup_timeout_ms: mcpTimeoutMsWire.optional(),
  tool_timeout_ms: mcpTimeoutMsWire.optional(),
  enabled_tools: z.array(z.string()).optional(),
  disabled_tools: z.array(z.string()).optional(),
} as const;

const mcpServerStdioWireSchema = z.object({
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: stringRecordWire.optional(),
  cwd: z.string().optional(),
  executor: z.enum(['local', 'kaos']).optional(),
  ...mcpServerCommonWireFields,
});

const mcpServerHttpWireSchema = z.object({
  transport: z.literal('http'),
  url: z.string().url(),
  headers: stringRecordWire.optional(),
  bearer_token_env_var: z.string().min(1).optional(),
  ...mcpServerCommonWireFields,
});

const mcpServerSseWireSchema = z.object({
  transport: z.literal('sse'),
  url: z.string().url(),
  headers: stringRecordWire.optional(),
  bearer_token_env_var: z.string().min(1).optional(),
  ...mcpServerCommonWireFields,
});

const mcpServerWireDiscriminated = z.discriminatedUnion('transport', [
  mcpServerStdioWireSchema,
  mcpServerHttpWireSchema,
  mcpServerSseWireSchema,
]);

/**
 * Wire `McpServerConfig` — snake_case form with the same preprocess sugar as
 * the on-disk schema: a payload without `transport` is normalized to `stdio`
 * (when `command` is present) or `http` (when `url` is present) before
 * discriminated-union validation.
 */
export const mcpServerConfigWireSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  if ('transport' in obj) return obj;
  if (typeof obj['command'] === 'string') return { ...obj, transport: 'stdio' };
  if (typeof obj['url'] === 'string') return { ...obj, transport: 'http' };
  return obj;
}, mcpServerWireDiscriminated);

export type WireMcpServerConfig = z.infer<typeof mcpServerConfigWireSchema>;

export const listMcpServersResponseSchema = z.object({
  servers: z.record(z.string(), mcpServerConfigWireSchema),
});
export type WireListMcpServersResponse = z.infer<typeof listMcpServersResponseSchema>;

export const upsertMcpServerRequestSchema = mcpServerConfigWireSchema;

export const mcpServerNameParamSchema = z.object({
  /**
   * MCP server name. Constrained to a safe identifier charset so it cannot
   * escape the `<kimi-home>/mcp.json` flat-file layout (no path separators,
   * no `..`, no NUL).
   */
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, 'name must match /^[a-zA-Z0-9_-]+$/'),
});
export type WireMcpServerNameParam = z.infer<typeof mcpServerNameParamSchema>;
