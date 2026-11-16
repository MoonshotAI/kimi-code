import type { TokenUsage } from '@moonshot-ai/core/llm/usage';

export type ArtexCostCurrency = 'EUR' | 'USD';

export type ArtexInputTokenMode = 'inclusive' | 'disjoint';

export interface ArtexLlmProfilePricing {
  readonly profileName: string;
  readonly currency?: ArtexCostCurrency;
  readonly inputPerM?: number;
  readonly outputPerM?: number;
  readonly cacheReadPerM?: number;
  readonly cacheWritePerM?: number;
  readonly inputTokenMode?: ArtexInputTokenMode;
}

export interface ArtexLlmUsageBucket {
  readonly profileName: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costEur?: number;
  readonly costUsd?: number;
}

export interface ArtexCostLedgerOptions {
  readonly usdPerEur?: number;
  readonly inputTokenMode?: ArtexInputTokenMode;
}

function hasAnyPrice(pricing: ArtexLlmProfilePricing): boolean {
  return (
    (pricing.inputPerM ?? 0) !== 0 ||
    (pricing.outputPerM ?? 0) !== 0 ||
    (pricing.cacheReadPerM ?? 0) !== 0 ||
    (pricing.cacheWritePerM ?? 0) !== 0
  );
}

export function computeTokenCost(
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  },
  pricing: ArtexLlmProfilePricing,
  defaultInputTokenMode: ArtexInputTokenMode = 'inclusive',
): number | undefined {
  if (!hasAnyPrice(pricing)) {
    return undefined;
  }
  const mode = pricing.inputTokenMode ?? defaultInputTokenMode;
  // In Anthropic/OpenAI raw usage, inputTokens includes cacheReadTokens; subtracting
  // prevents double-charging cached tokens at the full input rate.
  const freshInput =
    mode === 'inclusive'
      ? Math.max(0, usage.inputTokens - usage.cacheReadTokens)
      : Math.max(0, usage.inputTokens);
  const inputRate = pricing.inputPerM ?? 0;
  const outputRate = pricing.outputPerM ?? 0;
  const cacheReadRate = pricing.cacheReadPerM ?? 0;
  const cacheWriteRate = pricing.cacheWritePerM ?? 0;

  return (
    (freshInput / 1_000_000) * inputRate +
    (Math.max(0, usage.outputTokens) / 1_000_000) * outputRate +
    (Math.max(0, usage.cacheReadTokens) / 1_000_000) * cacheReadRate +
    (Math.max(0, usage.cacheWriteTokens) / 1_000_000) * cacheWriteRate
  );
}

export function applyCostLedger<T extends ArtexLlmUsageBucket>(
  buckets: readonly T[],
  pricingList: readonly ArtexLlmProfilePricing[],
  options: ArtexCostLedgerOptions = {},
): Array<T & { readonly costEur?: number; readonly costUsd?: number }> {
  const byProfile = new Map<string, ArtexLlmProfilePricing>();
  for (const pricing of pricingList) {
    if (!byProfile.has(pricing.profileName)) {
      byProfile.set(pricing.profileName, pricing);
    }
  }

  const usdPerEur =
    options.usdPerEur !== undefined && options.usdPerEur > 0 ? options.usdPerEur : undefined;
  const defaultMode = options.inputTokenMode ?? 'inclusive';

  return buckets.map((bucket) => {
    const pricing = byProfile.get(bucket.profileName);
    if (pricing === undefined) {
      return { ...bucket };
    }
    const cost = computeTokenCost(bucket, pricing, defaultMode);
    if (cost === undefined) {
      return { ...bucket };
    }
    const currency: ArtexCostCurrency = pricing.currency ?? 'EUR';
    switch (currency) {
      case 'EUR':
        return {
          ...bucket,
          costEur: cost,
          costUsd: usdPerEur === undefined ? bucket.costUsd : cost * usdPerEur,
        };
      case 'USD':
        return {
          ...bucket,
          costUsd: cost,
          costEur: usdPerEur === undefined ? bucket.costEur : cost / usdPerEur,
        };
      default: {
        const exhaustive: never = currency;
        return exhaustive;
      }
    }
  });
}

export function usageBucketFromTokenUsage(
  profileName: string,
  usage: TokenUsage,
): ArtexLlmUsageBucket {
  const cacheReadTokens = usage.inputCacheRead ?? 0;
  return {
    profileName,
    inputTokens: usage.inputOther + cacheReadTokens,
    outputTokens: usage.output,
    cacheReadTokens,
    cacheWriteTokens: usage.inputCacheCreation,
  };
}
