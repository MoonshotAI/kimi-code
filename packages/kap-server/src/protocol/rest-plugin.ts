import { z } from 'zod';

export const pluginGithubMetadataSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.object({
    kind: z.enum(['branch', 'tag', 'sha']),
    value: z.string(),
  }),
  installedSha: z.string().optional(),
});

export const pluginSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string().optional(),
  enabled: z.boolean(),
  state: z.enum(['ok', 'error']),
  skillCount: z.number(),
  mcpServerCount: z.number(),
  enabledMcpServerCount: z.number(),
  hookCount: z.number(),
  commandCount: z.number(),
  hasErrors: z.boolean(),
  source: z.enum(['local-path', 'zip-url', 'github']),
  origin: z.enum(['marketplace', 'custom', 'unknown']),
  catalogId: z.string().optional(),
  installedAt: z.string(),
  originalSource: z.string().optional(),
  github: pluginGithubMetadataSchema.optional(),
});
export type PluginSummaryWire = z.infer<typeof pluginSummarySchema>;

export const pluginMcpServerInfoSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
  iconUrl: z.string().optional(),
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

export const pluginSkillInfoSchema = z.object({
  name: z.string(),
  displayName: z.string().optional(),
  description: z.string().optional(),
});

export const pluginCapabilitiesSchema = z.object({
  skills: z.array(pluginSkillInfoSchema),
  mcpServers: z.array(pluginMcpServerInfoSchema),
});

export const pluginInfoSchema = pluginSummarySchema.extend({
  root: z.string(),
  updatedAt: z.string().optional(),
  manifestKind: z.enum(['kimi-plugin-root', 'kimi-plugin-dir']).optional(),
  manifestPath: z.string().optional(),
  manifest: z.unknown().optional(),
  skills: z.array(pluginSkillInfoSchema),
  mcpServers: z.array(pluginMcpServerInfoSchema),
  shadowedManifestPath: z.string().optional(),
  diagnostics: z.array(
    z.object({ severity: z.enum(['error', 'warn', 'info']), message: z.string() }),
  ),
});

export const pluginInfoQuerySchema = z.object({
  locale: z.string().min(1).optional(),
});

export const previewPluginRequestSchema = z
  .object({
    marketplaceId: z.string().min(1),
    expectedVersion: z.string().min(1),
    locale: z.string().min(1).optional(),
  })
  .strict();

export const listPluginsResponseSchema = z.object({
  plugins: z.array(pluginSummarySchema),
});
export type ListPluginsResponse = z.infer<typeof listPluginsResponseSchema>;

export const installPluginRequestSchema = z.union([
  z.object({ source: z.string().min(1) }).strict(),
  z
    .object({
      marketplaceId: z.string().min(1),
      expectedVersion: z.string().min(1),
    })
    .strict(),
]);
export type InstallPluginRequest = z.infer<typeof installPluginRequestSchema>;

export const pluginMarketplaceLocalizedTextSchema = z.object({
  cliDescription: z.string().optional(),
  longDescription: z.string().optional(),
  shortDescription: z.string().optional(),
});

export const pluginMarketplaceLocaleSchema = z.record(
  z.string(),
  z.union([z.string(), pluginMarketplaceLocalizedTextSchema]).optional(),
);

export const pluginMarketplaceDistributionSchema = z.object({
  category: z.enum(['official', 'third_party']),
  region: z.string().optional(),
  defaultInstall: z.boolean().optional(),
  weight: z.number().optional(),
  userLevel: z.unknown().optional(),
});

export const pluginMarketplaceEntrySchema = z.object({
  id: z.string(),
  classification: z.enum(['official', 'third_party']),
  tier: z.enum(['official', 'curated', 'third-party']),
  displayName: z.string(),
  description: z.string().optional(),
  homepage: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  version: z.string().optional(),
  source: z.string(),
  iconUrl: z.string().optional(),
  sha256sum: z.string().optional(),
  filename: z.string().optional(),
  cliDescription: z.string().optional(),
  locale: pluginMarketplaceLocaleSchema.optional(),
  defaultLocale: z.string().optional(),
  platforms: z.array(z.enum(['darwin', 'win32', 'linux', 'cloud'])).optional(),
  distribution: pluginMarketplaceDistributionSchema.optional(),
  billing: z.unknown().optional(),
  installed: z
    .object({
      version: z.string().optional(),
      enabled: z.boolean(),
    })
    .optional(),
  updateAvailable: z.boolean().optional(),
  capabilityId: z.string().optional(),
});
export type PluginMarketplaceEntryWire = z.infer<typeof pluginMarketplaceEntrySchema>;

export const pluginMarketplaceResponseSchema = z.object({
  entries: z.array(pluginMarketplaceEntrySchema),
});
export type PluginMarketplaceResponse = z.infer<typeof pluginMarketplaceResponseSchema>;

export const pluginIdParamSchema = z.object({
  tail: z.string().min(1),
});
export type PluginIdParam = z.infer<typeof pluginIdParamSchema>;
