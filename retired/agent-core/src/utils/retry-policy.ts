import { BASE_DELAY_MS, JITTER_FACTOR, MAX_DELAY_MS, RETRY_FACTOR } from '../loop/retry';

export const DEFAULT_AGENT_RETRY_ATTEMPTS = 5;

export const SUBAGENT_RATE_LIMIT_RETRY_BASE_MS = 3_000;
export const SUBAGENT_RATE_LIMIT_RETRY_FACTOR = 2;
export const SUBAGENT_RATE_LIMIT_GLOBAL_RETRY_MAX_MS = 60_000;
export const SUBAGENT_RATE_LIMIT_MAX_RETRIES = 10;
export const SUBAGENT_RATE_LIMIT_SUSPENDED_REASON =
  'Provider rate limit; subagent requeued for retry.';

export const SUBAGENT_TRANSIENT_MAX_RETRIES = 10;
export const SUBAGENT_TRANSIENT_SUSPENDED_REASON =
  'Transient provider error; subagent requeued for retry.';
export const SUBAGENT_TRANSIENT_BACKOFF_DELAYS_MS = [
  5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000, 60_000, 60_000, 60_000,
] as const;

export const SUBAGENT_FAILED_RESUME_MAX_RETRIES = 5;
export const SUBAGENT_FAILED_RESUME_RETRY_MS = 60_000;
export const SUBAGENT_FAILED_RESUME_SUSPENDED_REASON =
  'Subagent failed; requeued for automatic recovery.';

export function retryBackoffDelays(maxAttempts: number): number[] {
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = Math.min(
      BASE_DELAY_MS * Math.pow(RETRY_FACTOR, i),
      MAX_DELAY_MS,
    );
    delays.push(base + Math.random() * JITTER_FACTOR * base);
  }
  return delays;
}

export function readRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && value > 0 ? value : null;
}

export function applyRetryJitter(delayMs: number): number {
  return Math.round(delayMs * (0.75 + Math.random() * 0.5));
}

export function subagentTransientBackoffDelay(retryCount: number): number {
  const index = Math.min(
    Math.max(retryCount - 1, 0),
    SUBAGENT_TRANSIENT_BACKOFF_DELAYS_MS.length - 1,
  );
  return applyRetryJitter(SUBAGENT_TRANSIENT_BACKOFF_DELAYS_MS[index]!);
}

export function subagentRateLimitBackoffDelay(retryCount: number): number {
  const base = Math.min(
    SUBAGENT_RATE_LIMIT_RETRY_BASE_MS * Math.pow(SUBAGENT_RATE_LIMIT_RETRY_FACTOR, Math.max(0, retryCount - 1)),
    SUBAGENT_RATE_LIMIT_GLOBAL_RETRY_MAX_MS,
  );
  return applyRetryJitter(base);
}
