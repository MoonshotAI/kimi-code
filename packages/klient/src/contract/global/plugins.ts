/**
 * `pluginService` — plugin management and consumption. Mirrors
 * `agent-core-v2/app/plugin/plugin.ts` and `agent-core-v2/app/plugin/types.ts`;
 * nested `McpServerConfig` mirrors `agent-core-v2/agent/mcp/config-schema.ts`,
 * `HookDefConfig` mirrors `agent-core-v2/agent/externalHooks/configSection.ts`.
 * `pluginSkillRoots`, `enabledSessionStarts`, `enabledMcpServers`, and
 * `enabledHooks` are excluded (not part of the klient wire surface).
 */

import { z } from 'zod';

import { noResult } from '../helpers.js';
import type { ServiceContract } from '../types.js';

export const pluginDiagnosticSchema = z.object({
  severity: z.enum(['error', 'warn', 'info']),
  message: z.string(),
});

const pluginAuthorSchema = z.object({
  name: z.string().optional(),
  email: z.string().optional(),
});

const pluginSessionStartSchema = z.object({
  skill: z.string(),
});

const pluginInterfaceSchema = z.object({
  displayName: z.string().optional(),
  shortDescription: z.string().optional(),
  longDescription: z.string().optional(),
  developerName: z.string().optional(),
  websiteURL: z.string().optional(),
});

const stringRecordSchema = z.record(z.string(), z.string());

const mcpServerCommonFields = {
  enabled: z.boolean().optional(),
  startupTimeoutMs: z.number().int().min(1).optional(),
  toolTimeoutMs: z.number().int().min(1).optional(),
  enabledTools: z.array(z.string()).optional(),
  disabledTools: z.array(z.string()).optional(),
} as const;

const mcpServerConfigSchema = z.discriminatedUnion('transport', [
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

const hookDefSchema = z.object({
  event: z.enum([
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'PermissionRequest',
    'PermissionResult',
    'UserPromptSubmit',
    'Stop',
    'StopFailure',
    'Interrupt',
    'SessionStart',
    'SessionEnd',
    'SubagentStart',
    'SubagentStop',
    'PreCompact',
    'PostCompact',
    'Notification',
  ]),
  matcher: z.string().optional(),
  command: z.string().min(1),
  timeout: z.number().int().min(1).max(600).optional(),
});

const pluginCommandEntrySchema = z.object({
  path: z.string(),
  name: z.string(),
});

const pluginManifestKindSchema = z.enum(['kimi-plugin-root', 'kimi-plugin-dir']);

const pluginSourceSchema = z.enum(['local-path', 'zip-url', 'github']);

const pluginStateSchema = z.enum(['ok', 'error']);

const pluginGithubRefSchema = z.object({
  kind: z.enum(['branch', 'tag', 'sha']),
  value: z.string(),
});

export const pluginManifestSchema = z.object({
  name: z.string(),
  version: z.string().optional(),
  description: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  author: pluginAuthorSchema.optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  skills: z.array(z.string()).optional(),
  sessionStart: pluginSessionStartSchema.optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  hooks: z.array(hookDefSchema).optional(),
  commands: z.array(pluginCommandEntrySchema).optional(),
  interface: pluginInterfaceSchema.optional(),
  skillInstructions: z.string().optional(),
});

export const pluginMcpServerInfoSchema = z.object({
  name: z.string(),
  runtimeName: z.string(),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http', 'sse']),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  url: z.string().optional(),
  envKeys: z.array(z.string()).optional(),
  headerKeys: z.array(z.string()).optional(),
});

export const pluginGithubMetadataSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: pluginGithubRefSchema,
  installedSha: z.string().optional(),
});

export const pluginSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string().optional(),
  enabled: z.boolean(),
  state: pluginStateSchema,
  skillCount: z.number(),
  mcpServerCount: z.number(),
  enabledMcpServerCount: z.number(),
  hookCount: z.number(),
  commandCount: z.number(),
  hasErrors: z.boolean(),
  source: pluginSourceSchema,
  originalSource: z.string().optional(),
  github: pluginGithubMetadataSchema.optional(),
});

export const pluginInfoSchema = pluginSummarySchema.extend({
  root: z.string(),
  installedAt: z.string(),
  updatedAt: z.string().optional(),
  manifestKind: pluginManifestKindSchema.optional(),
  manifestPath: z.string().optional(),
  manifest: pluginManifestSchema.optional(),
  mcpServers: z.array(pluginMcpServerInfoSchema),
  shadowedManifestPath: z.string().optional(),
  diagnostics: z.array(pluginDiagnosticSchema),
});

/** Same shape as `reloadSummarySchema` in `./events.js` — keep in sync. */
export const reloadSummarySchema = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  errors: z.array(z.object({ id: z.string(), message: z.string() })),
});

export const pluginUpdateStatusSchema = z.object({
  id: z.string(),
  source: pluginSourceSchema,
  current: pluginGithubRefSchema.optional(),
  latest: pluginGithubRefSchema,
  displayVersion: z.string(),
  updateAvailable: z.boolean(),
});

export const pluginCommandDefSchema = z.object({
  pluginId: z.string(),
  name: z.string(),
  description: z.string(),
  body: z.string(),
  path: z.string(),
});

export const installPluginInputSchema = z.object({
  source: z.string(),
});

export const setPluginEnabledInputSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
});

export const setPluginMcpServerEnabledInputSchema = z.object({
  id: z.string(),
  server: z.string(),
  enabled: z.boolean(),
});

export const removePluginInputSchema = z.object({
  id: z.string(),
});

export const getPluginInfoInputSchema = z.object({
  id: z.string(),
});

export const pluginsContract = {
  listPlugins: { input: z.tuple([]), output: z.array(pluginSummarySchema) },
  installPlugin: { input: z.tuple([installPluginInputSchema]), output: pluginSummarySchema },
  setPluginEnabled: { input: z.tuple([setPluginEnabledInputSchema]), output: noResult },
  setPluginMcpServerEnabled: {
    input: z.tuple([setPluginMcpServerEnabledInputSchema]),
    output: noResult,
  },
  removePlugin: { input: z.tuple([removePluginInputSchema]), output: noResult },
  reloadPlugins: { input: z.tuple([]), output: reloadSummarySchema },
  getPluginInfo: { input: z.tuple([getPluginInfoInputSchema]), output: pluginInfoSchema },
  listPluginCommands: { input: z.tuple([]), output: z.array(pluginCommandDefSchema) },
  checkUpdates: { input: z.tuple([]), output: z.array(pluginUpdateStatusSchema) },
} satisfies ServiceContract;
