import { llmStatusErrorMessage, type LlmErrorMessage } from '#/llm-requester/errors';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
const JITTER_FACTOR = 0.25;

export interface LlmRetryOptions {
  readonly maxAttemptsPerStep?: number;
  readonly infiniteRetry?: boolean;
}

export interface LlmRetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export function resolveMaxAttempts(options: LlmRetryOptions | undefined): number {
  return Math.max(options?.maxAttemptsPerStep ?? DEFAULT_MAX_RETRY_ATTEMPTS, 1);
}

export function retryBackoffDelay(attemptIndex: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(RETRY_FACTOR, attemptIndex), MAX_DELAY_MS);
  return base + Math.random() * JITTER_FACTOR * base;
}

export function readRetryAfterMs(error: LlmErrorMessage): number | undefined {
  const retryAfterMs = llmStatusErrorMessage(error)?.retryAfterMs;
  return retryAfterMs !== null && retryAfterMs !== undefined && retryAfterMs > 0
    ? retryAfterMs
    : undefined;
}

export function isRetryableError(error: LlmErrorMessage): boolean {
  if (error.kind === 'syntax') return false;
  return error.retryable;
}

export function shouldRetry(
  options: LlmRetryOptions | undefined,
  attempt: number,
  error: LlmErrorMessage,
): boolean {
  if (options?.infiniteRetry === true) return true;
  return isRetryableError(error) && attempt < resolveMaxAttempts(options);
}

export function retryErrorFields(error: LlmErrorMessage): LlmRetryErrorFields {
  return {
    errorName: error.kind,
    errorMessage: error.message,
    statusCode: llmStatusErrorMessage(error)?.statusCode,
  };
}
