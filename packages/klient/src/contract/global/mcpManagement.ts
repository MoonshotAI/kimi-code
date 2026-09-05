/**
 * `mcpManagementService` — the unified MCP management plane. Mirrors
 * `agent-core-v2/app/mcpManagement/mcpManagement.ts`; `McpServerSource` /
 * `McpRegistryPluginOrigin` / `McpRegistryQuery` mirror
 * `agent-core-v2/app/mcpRegistry/mcpRegistry.ts`, and the redacted config
 * shape mirrors `agent-core-v2/mcpCore/configView.ts`.
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import {
  mcpServerHttpConfigSchema,
  mcpServerSseConfigSchema,
  mcpServerStdioConfigSchema,
} from '../mcp.js';
import type { ServiceContract } from '../types.js';

export const mcpServerSourceSchema = z.enum(['global', 'plugin', 'caller']);

export const mcpRegistryPluginOriginSchema = z.object({
  id: z.string(),
  /** Manifest-local server name (without the runtime prefix). */
  name: z.string(),
});

export const mcpRegistryQuerySchema = z.object({
  cwd: z.string().min(1).optional(),
});

export const mcpAuthStatusQuerySchema = z.object({
  cwd: z.string().min(1).optional(),
  verify: z.boolean().optional(),
});

/** `GlobalMcpServerConfig` — a named full config (add/update, inline test target). */
export const globalMcpServerConfigSchema = z.discriminatedUnion('transport', [
  mcpServerStdioConfigSchema.extend({ name: z.string().min(1) }),
  mcpServerHttpConfigSchema.extend({ name: z.string().min(1) }),
  mcpServerSseConfigSchema.extend({ name: z.string().min(1) }),
]);

/**
 * The wire config of a managed/inspected server: mutable entries carry the
 * full config (edit UIs prefill from it); read-only entries are redacted —
 * `env` / `headers` values are replaced by the sorted key lists `envKeys` /
 * `headerKeys`. One schema covers both shapes, mirroring the engine's
 * `McpServerConfig | McpServerConfigView` union.
 */
export const mcpServerConfigDataSchema = z.discriminatedUnion('transport', [
  mcpServerStdioConfigSchema.extend({ envKeys: z.array(z.string()).optional() }),
  mcpServerHttpConfigSchema.extend({ headerKeys: z.array(z.string()).optional() }),
  mcpServerSseConfigSchema.extend({ headerKeys: z.array(z.string()).optional() }),
]);

export const mcpManagedServerSchema = z.object({
  name: z.string(),
  config: mcpServerConfigDataSchema,
  source: mcpServerSourceSchema,
  origin: z.string(),
  mutable: z.boolean(),
  plugin: mcpRegistryPluginOriginSchema.optional(),
});

export const mcpServerTestTargetSchema = z.object({
  name: z.string().min(1).optional(),
  server: globalMcpServerConfigSchema.optional(),
  cwd: z.string().min(1).optional(),
});

export const mcpServerTestResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
});

export const mcpServerLocatorSchema = z.discriminatedUnion('source', [
  z.object({ source: z.literal('global'), name: z.string().min(1) }),
  z.object({
    source: z.literal('plugin'),
    pluginId: z.string().min(1),
    serverName: z.string().min(1),
  }),
]);

export const mcpServerAuthStateSchema = z.enum([
  'not-applicable',
  'bearer-token',
  'oauth-required',
  'oauth-authorized',
  'oauth-expired',
  'unavailable',
]);

export const mcpServerDescriptorSchema = z.object({
  /** `global:<name>` / `plugin:<pluginId>:<serverName>`, URL-encoded. */
  serverId: z.string(),
  locator: mcpServerLocatorSchema,
  runtimeName: z.string(),
  canonicalUrl: z.string().optional(),
  origin: mcpServerSourceSchema,
  config: mcpServerConfigDataSchema,
  enabled: z.boolean(),
  editable: z.boolean(),
});

export const mcpServerInspectionSchema = mcpServerDescriptorSchema.extend({
  authStatus: mcpServerAuthStateSchema,
  checkedAt: z.number().optional(),
  error: z.string().optional(),
});

export const mcpServerAuthStatusSchema = z.object({
  name: z.string(),
  authStatus: mcpServerAuthStateSchema,
});

export const mcpServerAuthBeginResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('authorization-required'),
    flowId: z.string(),
    authorizationUrl: z.string(),
  }),
  z.object({ status: z.literal('already-authorized') }),
]);

export const mcpServerAuthFlowHandleSchema = z.object({
  flowId: z.string().min(1),
  // Node overflows setTimeout delays above 2^31-1 into ~1ms; the REST schema
  // and the engine reject the same range.
  timeoutMs: z.number().int().min(1).max(2 ** 31 - 1).optional(),
});

export const mcpManagementContract = {
  listServers: {
    input: z.tuple([mcpRegistryQuerySchema.optional()]),
    output: z.array(mcpManagedServerSchema),
  },
  getServer: {
    input: z.tuple([z.string().min(1), mcpRegistryQuerySchema.optional()]),
    output: mcpManagedServerSchema,
  },
  addServer: {
    input: z.tuple([globalMcpServerConfigSchema, mcpRegistryQuerySchema.optional()]),
    output: z.array(mcpManagedServerSchema),
  },
  updateServer: {
    input: z.tuple([globalMcpServerConfigSchema, mcpRegistryQuerySchema.optional()]),
    output: z.array(mcpManagedServerSchema),
  },
  removeServer: {
    input: z.tuple([z.string().min(1), mcpRegistryQuerySchema.optional()]),
    output: z.array(mcpManagedServerSchema),
  },
  testServer: {
    input: z.tuple([mcpServerTestTargetSchema]),
    output: mcpServerTestResultSchema,
  },
  listAuthStatuses: {
    input: z.tuple([mcpAuthStatusQuerySchema.optional()]),
    output: z.array(mcpServerAuthStatusSchema),
  },
  inspectServers: {
    input: z.tuple([
      z.array(mcpServerLocatorSchema).optional(),
      mcpRegistryQuerySchema.optional(),
    ]),
    output: z.array(mcpServerInspectionSchema),
  },
  resolveServerByName: {
    input: z.tuple([z.string().min(1), mcpRegistryQuerySchema.optional()]),
    output: mcpServerLocatorSchema,
  },
  beginServerAuth: {
    input: z.tuple([mcpServerLocatorSchema, mcpRegistryQuerySchema.optional()]),
    output: mcpServerAuthBeginResultSchema,
  },
  completeServerAuth: {
    input: z.tuple([mcpServerAuthFlowHandleSchema]),
    output: noResult,
  },
  cancelServerAuth: {
    input: z.tuple([z.object({ flowId: z.string().min(1) })]),
    output: noResult,
  },
  resetServerAuth: {
    input: z.tuple([mcpServerLocatorSchema, mcpRegistryQuerySchema.optional()]),
    output: noResult,
  },
} satisfies ServiceContract;
