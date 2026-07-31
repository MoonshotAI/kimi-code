/**
 * Cache-hit statistics for a single completed LLM step.
 *
 * Pure helpers intended for the footer readout, the /usage panel, and the
 * cache-invalidation debug warning in the session event handler — not yet
 * wired into those consumers (currently exercised by tests only). All
 * ratios derive from the provider-reported TokenUsage breakdown
 * (inputCacheRead vs. total input), so they work uniformly across
 * Anthropic cache_control, Moonshot auto-caching, and OpenAI prompt
 * caching backends.
 */

import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

/**
 * A step whose prior prefix was at least this many tokens is eligible for
 * cache-break detection; short prompts churn naturally and are not worth
 * warning about.
 */
export const CACHE_BREAK_MIN_PREFIX_TOKENS = 10_000;

/**
 * A cache read below this fraction of the previous step's total input is
 * treated as a broken prefix (the provider re-prefilled most of it).
 */
export const CACHE_BREAK_READ_RATIO = 0.5;

export interface StepCacheStats {
  /** Input tokens served from the provider prompt cache. */
  readonly cacheRead: number;
  /** Total input tokens (other + cache read + cache creation). */
  readonly inputTotal: number;
}

/** Extract cache stats from a step's usage; undefined when there was no input. */
export function stepCacheStats(usage: TokenUsage | undefined): StepCacheStats | undefined {
  if (usage === undefined) return undefined;
  const inputTotal = usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
  if (!Number.isFinite(inputTotal) || inputTotal <= 0) return undefined;
  return { cacheRead: usage.inputCacheRead, inputTotal };
}

/** Whole-number cache-hit percent, or undefined when the total is unusable. */
export function cacheHitPercent(cacheRead: number, inputTotal: number): number | undefined {
  if (!Number.isFinite(inputTotal) || inputTotal <= 0) return undefined;
  const clamped = Math.min(Math.max(cacheRead, 0), inputTotal);
  return Math.round((clamped / inputTotal) * 100);
}

/**
 * Heuristic prefix-invalidation check: the previous step proved the provider
 * had a warm prefix of `previousInputTotal` tokens, so this step should read
 * most of it back from cache. A large shortfall means the prefix bytes
 * changed (system prompt / tools / history rewrite) or the provider evicted
 * the entry.
 */
export function isLikelyCacheBreak(
  previousInputTotal: number | undefined,
  stats: StepCacheStats,
): boolean {
  if (previousInputTotal === undefined) return false;
  if (previousInputTotal < CACHE_BREAK_MIN_PREFIX_TOKENS) return false;
  return stats.cacheRead < previousInputTotal * CACHE_BREAK_READ_RATIO;
}
