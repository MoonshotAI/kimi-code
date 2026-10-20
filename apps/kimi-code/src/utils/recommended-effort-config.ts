import type { ClientConfigFetchOptions } from '@moonshot-ai/kimi-code-product/client-configs/node';
import { z } from 'zod';

import { clientConfigs } from '#/utils/client-configs';

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
  return clientConfigs.get(CONFIG_NAME, recommendedEffortConfigSchema, options);
}

export function peekRecommendedEffortConfig(now?: number): RecommendedEffortConfig | undefined {
  return clientConfigs.peek(CONFIG_NAME, recommendedEffortConfigSchema, now);
}

export function resetRecommendedEffortConfigCache(): void {
  clientConfigs.reset(CONFIG_NAME);
}
