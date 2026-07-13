import { ChatProviderError } from '../errors';
import type { ProviderRequestAuth } from '../provider';

export function requireProviderApiKey(
  providerName: string,
  auth: ProviderRequestAuth | undefined,
  defaultApiKey?: string,
): string {
  const apiKey = auth?.apiKey ?? defaultApiKey;
  if (apiKey === undefined || apiKey.length === 0) {
    throw new ChatProviderError(
      `${providerName}: apiKey is required. Provide it via the constructor options, the provider's API-key environment variable, options.auth.apiKey on each request, or an OAuth login.`,
    );
  }
  return apiKey;
}

export function mergeRequestHeaders(
  defaultHeaders: Record<string, string> | undefined,
  requestHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged: Record<string, string> = {};
  if (defaultHeaders !== undefined) {
    Object.assign(merged, defaultHeaders);
  }
  if (requestHeaders !== undefined) {
    Object.assign(merged, requestHeaders);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Resolve the SDK client to use for a single provider request, applying the
 * standard precedence shared by every provider adapter:
 *
 * 1. If a `clientFactory` was supplied, delegate to it (it receives the
 *    per-request {@link ProviderRequestAuth}, defaulting to `{}`).
 * 2. Otherwise, if no per-request auth is needed AND a constructor-time
 *    client was cached, reuse the cached instance.
 * 3. Otherwise, call `build(auth)` to construct a fresh client for this
 *    request — typically using `requireProviderApiKey` plus
 *    `mergeRequestHeaders`.
 *
 * Note: when per-request `auth` is provided (e.g. an OAuth bearer token
 * resolved immediately before each call), step 3 fires and a brand-new SDK
 * client is constructed per request. This is intentional — it keeps short-lived
 * credentials out of any long-lived shared state and avoids racing concurrent
 * requests on a mutable client. The trade-off is that connection-pool / keep-
 * alive state inside the SDK client isn't reused across requests on the OAuth
 * path. For the current agent-CLI workload (one LLM call per turn step) this
 * is fine; if a future host needs high-throughput per-request auth, the
 * obvious optimization is a small LRU keyed on `(apiKey, headers digest)`.
 */
export function resolveAuthBackedClient<TClient>(
  state: {
    readonly cachedClient: TClient | undefined;
    readonly clientFactory: ((auth: ProviderRequestAuth) => TClient) | undefined;
  },
  auth: ProviderRequestAuth | undefined,
  build: (auth: ProviderRequestAuth | undefined) => TClient,
): TClient {
  if (state.clientFactory !== undefined) {
    return state.clientFactory(auth ?? {});
  }
  if (auth === undefined && state.cachedClient !== undefined) {
    return state.cachedClient;
  }
  return build(auth);
}
