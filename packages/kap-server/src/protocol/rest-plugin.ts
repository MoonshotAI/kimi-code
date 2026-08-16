/**
 *   GET  /v1/plugins
 *   GET  /v1/plugins/marketplace
 *   POST /v1/plugins
 *   POST /v1/plugins/{plugin_id}:{enable,disable,remove}
 */

import { z } from 'zod';

/** GitHub provenance for github-sourced plugins (domain PluginGithubMetadata). */
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
  originalSource: z.string().optional(),
  github: pluginGithubMetadataSchema.optional(),
});
export type PluginSummaryWire = z.infer<typeof pluginSummarySchema>;

export const listPluginsResponseSchema = z.object({
  plugins: z.array(pluginSummarySchema),
});
export type ListPluginsResponse = z.infer<typeof listPluginsResponseSchema>;

export const installPluginRequestSchema = z.object({
  /** local path, https zip URL, or GitHub repo URL — same semantics as the CLI. */
  source: z.string().min(1),
});
export type InstallPluginRequest = z.infer<typeof installPluginRequestSchema>;

export const pluginMarketplaceEntrySchema = z.object({
  id: z.string(),
  tier: z.enum(['official', 'curated', 'third-party']),
  displayName: z.string(),
  description: z.string().optional(),
  homepage: z.string().optional(),
  keywords: z.array(z.string()).optional(),
  /** Catalog-declared version; absent for entries that track a moving source. */
  version: z.string().optional(),
  source: z.string(),
  /** Present when the plugin is installed locally (detected on demand). */
  installed: z
    .object({
      version: z.string().optional(),
      enabled: z.boolean(),
    })
    .optional(),
  /** True only when both versions are valid semver and catalog > installed. */
  updateAvailable: z.boolean().optional(),
  /**
   * Set when the entry is a built-in capability's wiring plugin — install it
   * through `/capabilities/{capabilityId}:install` (binary runtime + wiring);
   * a plain plugin install sets up the wiring layer only.
   */
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
