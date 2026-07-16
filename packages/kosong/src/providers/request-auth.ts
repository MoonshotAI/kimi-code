import { ChatProviderError } from '#/errors';
import type { ProviderRequestAuth } from '#/provider';

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
 * Small LRU cache for per-request auth clients. Keyed on a digest of
 * `(apiKey, headers)` so that repeated requests with the same short-lived
 * credentials reuse the SDK client (and its connection pool) instead of
 * constructing a fresh one per request.
 *
 * The cache is bounded to `maxSize` entries. When full, the oldest entry
 * is evicted. Each entry has a `createdAt` timestamp; entries older than
 * `ttlMs` are treated as misses and refreshed.
 */
export class AuthClientLRU<TClient> {
  private readonly entries = new Map<string, { client: TClient; createdAt: number }>();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(maxSize = 4, ttlMs = 5 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
  }

  get(auth: ProviderRequestAuth | undefined): TClient | undefined {
    if (auth === undefined) return undefined;
    const key = this.digest(auth);
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (Date.now() - entry.createdAt > this.ttlMs) {
      this.entries.delete(key);
      return undefined;
    }
    // Move to end (most recently used).
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.client;
  }

  set(auth: ProviderRequestAuth | undefined, client: TClient): void {
    if (auth === undefined) return;
    const key = this.digest(auth);
    if (this.entries.size >= this.maxSize && !this.entries.has(key)) {
      // Evict oldest (first entry in Map insertion order).
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) this.entries.delete(oldestKey);
    }
    this.entries.set(key, { client, createdAt: Date.now() });
  }

  clear(): void {
    this.entries.clear();
  }

  private digest(auth: ProviderRequestAuth): string {
    const parts: string[] = [];
    if (auth.apiKey !== undefined) parts.push(`k:${this.fingerprint(auth.apiKey)}`);
    if (auth.bearerToken !== undefined) parts.push(`b:${this.fingerprint(auth.bearerToken)}`);
    if (auth.headers !== undefined) {
      const entries = Object.entries(auth.headers).sort(([a], [b]) => a.localeCompare(b));
      for (const [k, v] of entries) parts.push(`h:${k}=${this.fingerprint(v)}`);
    }
    return parts.join('|');
  }

  private fingerprint(value: string): string {
    const len = value.length;
    if (len === 0) return '0::';
    const first = value.charAt(0);
    const last = value.charAt(len - 1);
    return `${len}:${first}...${last}`;
  }
}

/**
 * Resolve the SDK client to use for a single provider request, applying the
 * standard precedence shared by every provider adapter:
 *
 * 1. If a `clientFactory` was supplied, delegate to it (it receives the
 *    per-request {@link ProviderRequestAuth}, defaulting to `{}`).
 * 2. Otherwise, if no per-request auth is needed AND a constructor-time
 *    client was cached, reuse the cached instance.
 * 3. Otherwise, if an `authClientLRU` is configured and has an entry for
 *    this auth, reuse it (avoids constructing a fresh SDK client per
 *    request when the same OAuth token is used repeatedly).
 * 4. Otherwise, call `build(auth)` to construct a fresh client for this
 *    request — typically using `requireProviderApiKey` plus
 *    `mergeRequestHeaders`. The result is cached in the LRU for future
 *    requests with the same auth.
 */
export function resolveAuthBackedClient<TClient>(
  state: {
    readonly cachedClient: TClient | undefined;
    readonly clientFactory: ((auth: ProviderRequestAuth) => TClient) | undefined;
    readonly authClientLRU?: AuthClientLRU<TClient>;
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
  // Check LRU cache for per-request auth reuse.
  if (auth !== undefined && state.authClientLRU !== undefined) {
    const cached = state.authClientLRU.get(auth);
    if (cached !== undefined) return cached;
    const client = build(auth);
    state.authClientLRU.set(auth, client);
    return client;
  }
  return build(auth);
}
