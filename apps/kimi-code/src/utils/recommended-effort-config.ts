import { z } from 'zod';

import {
  getClientConfig,
  peekClientConfig,
  resetClientConfigCache,
  type ClientConfigFetchOptions,
} from '#/utils/client-configs';

const CONFIG_NAME = 'recommended_effort';

export interface RecommendedEffortEntry {
  version: number;
  recommended_default_effort: string;
}

export type RecommendedEffortConfig = Record<string, RecommendedEffortEntry>;

const recommendedEffortEntrySchema = z.object({
  version: z.number().int().min(0),
  recommended_default_effort: z.string(),
});

const recommendedEffortConfigSchema = z
  .record(z.string(), z.unknown())
  .transform((record): RecommendedEffortConfig => {
    const config: RecommendedEffortConfig = {};
    for (const [model, rawEntry] of Object.entries(record)) {
      const parsed = recommendedEffortEntrySchema.safeParse(rawEntry);
      if (parsed.success) config[model] = parsed.data;
    }
    return config;
  });

export async function getRecommendedEffortConfig(
  options: ClientConfigFetchOptions = {},
): Promise<RecommendedEffortConfig | undefined> {
  return getClientConfig(CONFIG_NAME, recommendedEffortConfigSchema, options);
}

export function peekRecommendedEffortConfig(now?: number): RecommendedEffortConfig | undefined {
  return peekClientConfig(CONFIG_NAME, recommendedEffortConfigSchema, now);
}

export function resetRecommendedEffortConfigCache(): void {
  resetClientConfigCache(CONFIG_NAME);
}
