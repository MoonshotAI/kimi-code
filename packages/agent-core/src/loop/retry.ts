import { sleep } from '@antfu/utils';
import { isProviderRateLimitError } from '@moonshot-ai/kosong';

import type { Logger } from '#/logging/types';

import { abortable } from '../utils/abort';
import type { LoopEventDispatcher } from './events';
import { isAbortError } from './errors';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';

// Default retry budget per step: 10 attempts (9 retries).
export const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
const JITTER_FACTOR = 0.25;

// Overload backoff: 5s/10s/30s for 503 errors
const OVERLOAD_BASE_DELAY_MS = 5_000;
const OVERLOAD_MAX_DELAY_MS = 30_000;
const OVERLOAD_RETRY_FACTOR = 2;

// Rate-limit backoff: 15s/30s/60s for Xunfei TPM codes
const RATE_LIMIT_BASE_DELAY_MS = 15_000;
const RATE_LIMIT_MAX_DELAY_MS = 60_000;
const RATE_LIMIT_RETRY_FACTOR = 2;

function isOverloadError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' && statusCode === 503;
}

export interface ChatWithRetryInput {
  readonly llm: LLM;
  readonly params: LLMChatParams;
  readonly dispatchEvent: LoopEventDispatcher;
  readonly turnId: string;
  readonly currentStep: number;
  readonly stepUuid: string;
  readonly maxAttempts?: number;
  readonly log?: Logger | undefined;
}

export async function chatWithRetry(input: ChatWithRetryInput): Promise<LLMChatResponse> {
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_RETRY_ATTEMPTS;

  if (input.llm.isRetryableError === undefined || maxAttempts <= 1) {
    const effectiveMaxAttempts = Math.max(maxAttempts, 1);
    try {
      return await input.llm.chat(paramsForAttempt(input, 1, effectiveMaxAttempts));
    } catch (error) {
      logRequestFailure(input, error, 1, effectiveMaxAttempts);
      throw error;
    }
  }

  const delays = retryBackoffDelays(maxAttempts);

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await input.llm.chat(paramsForAttempt(input, attempt, maxAttempts));
    } catch (error) {
      if (attempt >= maxAttempts || !input.llm.isRetryableError(error)) {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

      const delayMs =
        readRetryAfterMs(error) ??
        (isProviderRateLimitError(error)
          ? tieredBackoffDelay(attempt, RATE_LIMIT_BASE_DELAY_MS, RATE_LIMIT_MAX_DELAY_MS, RATE_LIMIT_RETRY_FACTOR)
          : isOverloadError(error)
            ? tieredBackoffDelay(attempt, OVERLOAD_BASE_DELAY_MS, OVERLOAD_MAX_DELAY_MS, OVERLOAD_RETRY_FACTOR)
            : delays[attempt - 1] ?? 0);
      input.params.signal.throwIfAborted();
      input.dispatchEvent({
        type: 'step.retrying',
        turnId: input.turnId,
        step: input.currentStep,
        stepUuid: input.stepUuid,
        failedAttempt: attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        ...retryErrorFields(error),
      });
      await sleepForRetry(delayMs, input.params.signal);
    }
  }
}

function logRequestFailure(input: ChatWithRetryInput, error: unknown, attempt: number, maxAttempts: number): void {
  if (isAbortError(error) || input.params.signal.aborted) return;
  input.log?.warn('llm request failed', {
    turnStep: `${input.turnId}.${String(input.currentStep)}`,
    attempt: `${String(attempt)}/${String(maxAttempts)}`,
    model: input.llm.modelName,
    ...retryErrorFields(error),
  });
}

function paramsForAttempt(input: ChatWithRetryInput, attempt: number, maxAttempts: number): LLMChatParams {
  const turnStep = `${input.turnId}.${String(input.currentStep)}`;
  return {
    ...input.params,
    requestLogFields:
      attempt === 1
        ? { ...input.params.requestLogFields, turnStep }
        : { ...input.params.requestLogFields, turnStep, attempt: `${String(attempt)}/${String(maxAttempts)}` },
  };
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

function tieredBackoffDelay(attempt: number, base: number, max: number, factor: number): number {
  return Math.min(base * Math.pow(factor, attempt - 1), max);
}

function readRetryAfterMs(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === 'number' && value > 0 ? value : null;
}

export async function sleepForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await abortable(sleep(delayMs), signal);
}

interface RetryErrorFields {
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

function retryErrorFields(error: unknown): RetryErrorFields {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
    statusCode: maybeStatusCode(error),
  };
}

function maybeStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
