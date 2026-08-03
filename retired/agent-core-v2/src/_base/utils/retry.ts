/**
 * `_base` retry helpers — exponential and server-directed backoff, abortable
 * sleeps, and error-field extraction shared by retry policies (the loop's
 * `stepRetry` plugin, full-compaction's self-managed resends). The default
 * budget is 10 attempts per step (kept in sync with v1
 * `agent-core/loop/retry.ts`): the 500ms ×2 ramp capped at 32s waits out
 * multi-minute provider overload (sustained 429s) before a turn fails.
 *
 * Tiered backoff: rate-limit errors use 15–60s, overload/503 use 5–30s,
 * transient errors use the default 500ms–32s exponential ramp. These
 * longer backoff tiers avoid thundering herd on reverse-proxy upstreams
 * (e.g. Xunfei relay) where the SDK's uniform 2-retry default causes
 * cascading 503s.
 */

import { abortable } from '#/_base/utils/abort';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

// Kept in sync with agent-core/src/loop/retry.ts

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
const JITTER_FACTOR = 0.25;

const OVERLOAD_BASE_DELAY_MS = 5_000;
const OVERLOAD_MAX_DELAY_MS = 30_000;
const OVERLOAD_RETRY_FACTOR = 2;

const RATE_LIMIT_BASE_DELAY_MS = 15_000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;
const RATE_LIMIT_RETRY_FACTOR = 2;

export interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = Math.min(BASE_DELAY_MS * Math.pow(RETRY_FACTOR, i), MAX_DELAY_MS);
    delays.push(base + Math.random() * JITTER_FACTOR * base);
  }
  return delays;
}

function tieredBackoffDelay(
  attempt: number,
  base: number,
  max: number,
  factor: number,
): number {
  const raw = Math.min(base * Math.pow(factor, attempt - 1), max);
  return raw + Math.random() * JITTER_FACTOR * raw;
}

export function overloadBackoffDelay(attempt: number): number {
  return tieredBackoffDelay(attempt, OVERLOAD_BASE_DELAY_MS, OVERLOAD_MAX_DELAY_MS, OVERLOAD_RETRY_FACTOR);
}

export function rateLimitBackoffDelay(attempt: number): number {
  return tieredBackoffDelay(attempt, RATE_LIMIT_BASE_DELAY_MS, RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_RETRY_FACTOR);
}

export function isOverloadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const statusCode = maybeStatusCode(error);
  if (typeof statusCode === 'number') {
    if (statusCode === 503) return true;
    if (statusCode === 529) return true;
    if (statusCode === 500) {
      const message = error instanceof Error ? error.message : String(error);
      return /overload/i.test(message);
    }
  }
  return false;
}

export function readRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && value > 0 ? value : null;
}

export async function sleepForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const sleepPromise = sleep(delayMs);
  if (signal === undefined) {
    await sleepPromise;
    return;
  }
  await abortable(sleepPromise, signal);
}

export function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const details = (error as { details?: unknown }).details;
  if (details !== null && typeof details === 'object') {
    const detailsStatus = (details as { statusCode?: unknown }).statusCode;
    if (typeof detailsStatus === 'number') return detailsStatus;
  }
  return undefined;
}
