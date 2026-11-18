import type { ClientConfigFetchOptions } from '@moonshot-ai/kimi-code-product/client-configs/node';
import { z } from 'zod';

import { clientConfigs } from '#/utils/client-configs';

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

export async function getCacheHintConfig(
  options: CacheHintConfigFetchOptions = {},
): Promise<CacheHintConfig | undefined> {
  return clientConfigs.get(CONFIG_NAME, cacheHintConfigSchema, options);
}

export function refreshCacheHintConfigInBackground(
  options: CacheHintConfigFetchOptions = {},
): void {
  void getCacheHintConfig(options).catch(() => undefined);
}

export function peekCacheHintConfig(now?: number): CacheHintConfig | undefined {
  return clientConfigs.peek(CONFIG_NAME, cacheHintConfigSchema, now);
}

export function resetCacheHintConfigCache(): void {
  clientConfigs.reset(CONFIG_NAME);
}
