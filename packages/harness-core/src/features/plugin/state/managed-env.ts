import { KIMI_CODE_PROVIDER_NAME } from '@moonshot-ai/kimi-code-oauth';

import type { McpServerConfig } from '#/features/mcp/core/config-schema';
import type { CatalogProviderInfo } from '#/features/provider-catalog/index';

import type { PluginMcpServerEntry } from '../types';

export const KIMI_CODE_BASE_URL_ENV = 'KIMI_CODE_BASE_URL';
export const KIMI_CODE_OAUTH_HOST_ENV = 'KIMI_CODE_OAUTH_HOST';
export const KIMI_OAUTH_HOST_ENV = 'KIMI_OAUTH_HOST';

export function managedKimiCodeEnvForPlugins(
  providerInfo: (providerId: string) => CatalogProviderInfo | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const info = providerInfo(KIMI_CODE_PROVIDER_NAME);
  const envBaseUrl = env[KIMI_CODE_BASE_URL_ENV];
  const envOAuthHost = env[KIMI_CODE_OAUTH_HOST_ENV] ?? env[KIMI_OAUTH_HOST_ENV];
  const hasEnvOverride = envBaseUrl !== undefined || envOAuthHost !== undefined;
  const baseUrl = envBaseUrl !== undefined ? envBaseUrl.replace(/\/+$/, '') : info?.baseUrl;
  const oauthHost = hasEnvOverride ? envOAuthHost : info?.oauth?.oauthHost;
  const out: Record<string, string> = {};
  if (baseUrl !== undefined) out[KIMI_CODE_BASE_URL_ENV] = baseUrl;
  if (oauthHost !== undefined) out[KIMI_CODE_OAUTH_HOST_ENV] = oauthHost;
  return out;
}

export function withManagedKimiPluginEnv(
  pluginServers: Record<string, McpServerConfig>,
  managedEnv: Record<string, string>,
): Record<string, McpServerConfig> {
  if (Object.keys(managedEnv).length === 0) return pluginServers;
  const out: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(pluginServers)) {
    out[name] =
      server.transport === 'stdio' ? { ...server, env: { ...server.env, ...managedEnv } } : server;
  }
  return out;
}

export function withManagedKimiPluginEnvOnEntries(
  entries: readonly PluginMcpServerEntry[],
  managedEnv: Record<string, string>,
): readonly PluginMcpServerEntry[] {
  if (Object.keys(managedEnv).length === 0) return entries;
  return entries.map((entry) =>
    entry.config.transport === 'stdio'
      ? { ...entry, config: { ...entry.config, env: { ...entry.config.env, ...managedEnv } } }
      : entry,
  );
}
