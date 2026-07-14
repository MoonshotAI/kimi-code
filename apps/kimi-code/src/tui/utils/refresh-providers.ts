import {
  refreshProviderModels,
  type ProviderChange,
  type RefreshProviderOptions,
  type RefreshProviderScope,
  type RefreshResult,
} from '@moonshot-ai/kimi-code-oauth';
import type { ManagedKimiConfigShape } from '@moonshot-ai/kimi-code-oauth';

import type { CoreConfig, CoreConfigPatch, OAuthRef } from '#/core/index';

/**
 * CLI-side host for provider-model refresh. Typed against the v2 resolved
 * config (`CoreConfig`) so TUI callers stay on the core facade; the adapter
 * below bridges to the oauth orchestrator's `ManagedKimiConfigShape` at the
 * single package boundary.
 */
export interface RefreshProviderHost {
  getConfig(): Promise<CoreConfig>;
  removeProvider(providerId: string): Promise<CoreConfig>;
  setConfig(patch: CoreConfigPatch): Promise<CoreConfig>;
  resolveOAuthToken(providerName: string, oauthRef?: OAuthRef): Promise<string>;
  /** Product User-Agent sent on custom-registry (api.json) fetches. */
  readonly userAgent?: string;
}

export type { ProviderChange, RefreshProviderOptions, RefreshProviderScope, RefreshResult };

/**
 * Refresh remote model metadata for the configured providers. Thin adapter over
 * the shared `refreshProviderModels` orchestrator in `@moonshot-ai/kimi-code-oauth`
 * (which is also what the daemon's scheduled/manual refresh uses).
 *
 * The v2 resolved config is the same TOML projection the oauth orchestrator
 * reads at runtime, but it is untyped (`CoreConfig` is `Record<string,
 * unknown>`) while the orchestrator requires a present `providers` key. The
 * `as unknown as ManagedKimiConfigShape` casts bridge that type gap at this
 * boundary only; no TUI caller needs to know about the oauth shape.
 */
export async function refreshAllProviderModels(
  host: RefreshProviderHost,
  options: RefreshProviderOptions = {},
): Promise<RefreshResult> {
  return refreshProviderModels(
    {
      getConfig: async () => (await host.getConfig()) as unknown as ManagedKimiConfigShape,
      removeProvider: async (providerId) =>
        (await host.removeProvider(providerId)) as unknown as ManagedKimiConfigShape,
      setConfig: async (patch) =>
        (await host.setConfig(patch as CoreConfigPatch)) as unknown as ManagedKimiConfigShape,
      resolveOAuthToken: (providerName, oauthRef) =>
        host.resolveOAuthToken(providerName, oauthRef as unknown as OAuthRef),
      userAgent: host.userAgent,
    },
    options,
  );
}
