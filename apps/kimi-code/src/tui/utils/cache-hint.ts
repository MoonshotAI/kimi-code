import type { CacheHintConfig } from '#/utils/cache-hint-config';

export interface CacheHintInput {
  readonly now: number;
  readonly lastActiveAt?: number;
  readonly totalTokens?: number;
  readonly modelId?: string;
  readonly config?: CacheHintConfig;
  readonly dismissed: boolean;
}

export type CacheHintDecision =
  | { readonly kind: 'skip' }
  | { readonly kind: 'hint'; readonly idleSeconds: number; readonly totalTokens: number };

export function evaluateCacheHint(input: CacheHintInput): CacheHintDecision {
  if (input.dismissed) return { kind: 'skip' };
  const { config, modelId, lastActiveAt, totalTokens } = input;
  if (config === undefined || modelId === undefined) return { kind: 'skip' };
  if (lastActiveAt === undefined || totalTokens === undefined) return { kind: 'skip' };
  const rule = config.config[modelId];
  if (rule === undefined) return { kind: 'skip' };
  const idleMs = input.now - lastActiveAt;
  if (idleMs <= rule.cache_duration * 1000) return { kind: 'skip' };
  if (totalTokens < rule.min_tokens_to_hint) return { kind: 'skip' };
  return { kind: 'hint', idleSeconds: Math.floor(idleMs / 1000), totalTokens };
}

export function formatIdleDuration(idleSeconds: number): string {
  const minutes = Math.max(1, Math.floor(idleSeconds / 60));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}
