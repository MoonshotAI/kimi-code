import { abortable } from '#/_base/utils/abort';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

const RETRY_MIN_TIMEOUT_MS = 300;
const RETRY_MAX_TIMEOUT_MS = 5000;
const RETRY_FACTOR = 2;

export interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  return Array.from({ length: Math.max(maxAttempts - 1, 0) }, (_unused, index) => {
    const baseDelay = Math.min(
      RETRY_MAX_TIMEOUT_MS,
      RETRY_MIN_TIMEOUT_MS * RETRY_FACTOR ** index,
    );
    return Math.round(baseDelay * (1 + Math.random()));
  });
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

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
