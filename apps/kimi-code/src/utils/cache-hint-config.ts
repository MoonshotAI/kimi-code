import type { ClientConfigFetchOptions } from '@moonshot-ai/kimi-code-product/client-configs/node';
import { z } from 'zod';

import { clientConfigs } from '#/utils/client-configs';

/** The cache-hint rules are one named config on the client-configs endpoint. */
const CONFIG_NAME = 'estimated_cache_duration';

const cacheHintModelRuleSchema = z.object({
  min_tokens_to_hint: z.number(),
  cache_duration: z.number(),
});

const cacheHintConfigSchema = z.object({
  version: z.literal(1),
  config: z.record(z.string(), cacheHintModelRuleSchema),
});

export type CacheHintConfig = z.infer<typeof cacheHintConfigSchema>;
export type CacheHintConfigFetchOptions = ClientConfigFetchOptions;

/**
 * Returns the cache-hint config, preferring the cache (1 day, persisted
 * across restarts). Any failure resolves to `undefined` — callers treat
 * that as "do not hint".
 */
export async function getCacheHintConfig(
  options: CacheHintConfigFetchOptions = {},
): Promise<CacheHintConfig | undefined> {
  return clientConfigs.get(CONFIG_NAME, cacheHintConfigSchema, options);
}

/** Fire-and-forget refresh, e.g. on new-session creation. Never throws. */
export function refreshCacheHintConfigInBackground(
  options: CacheHintConfigFetchOptions = {},
): void {
  void getCacheHintConfig(options).catch(() => undefined);
}

/** Synchronous peek at the fresh cache; undefined when missing or stale. */
export function peekCacheHintConfig(now?: number): CacheHintConfig | undefined {
  return clientConfigs.peek(CONFIG_NAME, cacheHintConfigSchema, now);
}

/** Test hook: drop the in-process cache. */
export function resetCacheHintConfigCache(): void {
  clientConfigs.reset(CONFIG_NAME);
}
