import type { CacheHintConfig } from '#/utils/cache-hint-config';

export interface CacheHintInput {
  /** Current time, epoch ms. */
  readonly now: number;
  /** Last session activity, epoch ms. Missing → skip. */
  readonly lastActiveAt?: number;
  /** Current context size in tokens. Missing → skip (no local estimation). */
  readonly totalTokens?: number;
  /** Upstream model ID used to look up the rule. Missing/unconfigured → skip. */
  readonly modelId?: string;
  /** Fetch failure → undefined → skip. */
  readonly config?: CacheHintConfig;
  /** User chose "Don't ask me again" (tui.toml). */
  readonly dismissed: boolean;
}

export type CacheHintDecision =
  | { readonly kind: 'skip' }
  | { readonly kind: 'hint'; readonly idleSeconds: number; readonly totalTokens: number };

/**
 * Shared trigger rule for both the resume and the idle scenarios. Every
 * missing-data branch skips — false negatives are acceptable, false positives
 * are not.
 */
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

/** `45m` / `3h 20m` / `26d 22h`. */
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
