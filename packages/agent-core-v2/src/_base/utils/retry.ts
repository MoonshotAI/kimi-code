/**
 * `_base` retry helpers — exponential and server-directed backoff, abortable
 * sleeps, and error-field extraction shared by retry policies (the loop's
 * `stepRetry` plugin, full-compaction's self-managed resends).
 */

import { abortable } from '#/_base/utils/abort';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
const JITTER_FACTOR = 0.25;

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
