import {
  refreshProviderCatalog,
  refreshProviderModels,
  type ProviderChange,
  type RefreshCatalogResult,
  type RefreshProviderOptions,
  type RefreshProviderScope,
  type RefreshResult,
} from '@moonshot-ai/kimi-code-oauth';
import type { KimiConfig, KimiConfigPatch, OAuthRef } from '@moonshot-ai/kimi-code-sdk';

/**
 * CLI-side host for provider-model refresh. Kept on the SDK's full config types
 * so existing TUI callers (and tests) don't change; the daemon uses the oauth
 * package's `ManagedKimiConfigShape`-typed host directly.
 */
export interface RefreshProviderHost {
  getConfig(): Promise<KimiConfig>;
  removeProvider(providerId: string): Promise<KimiConfig>;
  setConfig(patch: KimiConfigPatch): Promise<KimiConfig>;
  resolveOAuthToken(providerName: string, oauthRef?: OAuthRef): Promise<string>;
  /** Product User-Agent sent on custom-registry (api.json) fetches. */
  readonly userAgent?: string;
}

export type { ProviderChange, RefreshCatalogResult, RefreshProviderOptions, RefreshProviderScope, RefreshResult };

/**
 * Refresh remote model metadata for the configured providers. Thin adapter over
 * the shared `refreshProviderModels` orchestrator in `@moonshot-ai/kimi-code-oauth`
 * (which is also what the daemon's scheduled/manual refresh uses).
 */
export async function refreshAllProviderModels(
  host: RefreshProviderHost,
  options: RefreshProviderOptions = {},
): Promise<RefreshResult> {
  return refreshProviderModels(
    {
      getConfig: () => host.getConfig(),
      removeProvider: (providerId) => host.removeProvider(providerId),
      setConfig: (patch) => host.setConfig(patch as unknown as KimiConfigPatch),
      resolveOAuthToken: (providerName, oauthRef) =>
        host.resolveOAuthToken(providerName, oauthRef as unknown as OAuthRef),
      userAgent: host.userAgent,
    },
    options,
  );
}

/**
 * On-demand catalog refresh for OpenAI-compatible providers (the `/refresh-catalog`
 * command). Fetches each provider's `/models` endpoint, preserves curated
 * `maxContextSize` values, and enriches names/capabilities from models.dev.
 * Never refreshes during the automatic startup refresh.
 */
export async function refreshCatalogProviderModels(
  host: RefreshProviderHost,
  options: { providerId?: string } = {},
): Promise<RefreshCatalogResult> {
  return refreshProviderCatalog(
    {
      getConfig: () => host.getConfig(),
      removeProvider: (providerId) => host.removeProvider(providerId),
      setConfig: (patch) => host.setConfig(patch as unknown as KimiConfigPatch),
      resolveOAuthToken: (providerName, oauthRef) =>
        host.resolveOAuthToken(providerName, oauthRef as unknown as OAuthRef),
      userAgent: host.userAgent,
    },
    options,
  );
}
