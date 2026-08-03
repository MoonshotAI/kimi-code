import { sleep } from '@antfu/utils';
import { isProviderRateLimitError } from '@moonshot-ai/kosong';

import { APIStatusError } from '@moonshot-ai/kosong';
import type { Logger } from '#/logging/types';

import { abortable } from '../utils/abort';
import type { LoopEventDispatcher } from './events';
import { isAbortError } from './errors';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';

// Default retry budget per step: 10 attempts (9 retries).
// Kept in sync with agent-core-v2/src/_base/utils/retry.ts
export const DEFAULT_MAX_RETRY_ATTEMPTS = 10;

export const BASE_DELAY_MS = 500;
export const MAX_DELAY_MS = 32_000;
export const RETRY_FACTOR = 2;
export const JITTER_FACTOR = 0.25;

// Overload backoff (503, "system busy", stream interrupted). Start at 5s
// with a 30s cap, factor 2 — gentler than rate-limit but much longer than
// transient to ride out sustained upstream overload without contributing to
// the thundering herd.
const OVERLOAD_BASE_DELAY_MS = 5_000;
const OVERLOAD_MAX_DELAY_MS = 30_000;
const OVERLOAD_RETRY_FACTOR = 2;

// Rate-limit backoff (429, Xunfei TPM codes). TPM limits typically refresh
// per minute, so a sub-minute backoff is wasted. 15s min, 60s cap.
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
    input.params.trace?.reset();
    try {
      const response = await input.llm.chat(paramsForAttempt(input, 1, effectiveMaxAttempts));
      input.params.trace?.capture(response.traceId);
      return response;
    } catch (error) {
      captureAttemptTraceId(input, error);
      logRequestFailure(input, error, 1, effectiveMaxAttempts);
      throw error;
    }
  }

  const delays = retryBackoffDelays(maxAttempts);

  for (let attempt = 1; ; attempt += 1) {
    input.params.trace?.reset();
    try {
      const response = await input.llm.chat(paramsForAttempt(input, attempt, maxAttempts));
      input.params.trace?.capture(response.traceId);
      return response;
    } catch (error) {
      captureAttemptTraceId(input, error);
      if (attempt >= maxAttempts || !input.llm.isRetryableError(error)) {
        logRequestFailure(input, error, attempt, maxAttempts);
        throw error;
      }

// Tiered backoff: rate-limit errors get the longest delay (TPM
      // windows refresh per minute), overload/503 get a moderate
      // backoff, transient errors use the default exponential ramp.
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

/**
 * Surface a failed attempt's trace id through the same early-capture channel
 * as a successful attempt. A status-error response still carried response
 * headers, so its `x-trace-id` is available on the converted error; writing
 * it here (before the failure propagates to the loop's `turn.interrupted`
 * dispatch) lets turn-level telemetry attribute the turn to the failed
 * request rather than the previous successful one. Mid-stream failures were
 * already captured by the attempt's request trace; failures before any
 * response (network errors, local aborts) keep the attempt-start reset.
 */
function captureAttemptTraceId(input: ChatWithRetryInput, error: unknown): void {
  const statusError = findAPIStatusError(error);
  if (statusError?.traceId !== null && statusError?.traceId !== undefined) {
    input.params.trace?.capture(statusError.traceId);
  }
}

export function findAPIStatusError(error: unknown): APIStatusError | undefined {
  let current = error;
  const visited = new Set<unknown>();
  while (current !== null && typeof current === 'object' && !visited.has(current)) {
    if (current instanceof APIStatusError) return current;
    visited.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function paramsForAttempt(
  input: ChatWithRetryInput,
  attempt: number,
  maxAttempts: number,
): LLMChatParams {
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

function tieredBackoffDelay(
  attempt: number,
  base: number,
  max: number,
  factor: number,
): number {
  return Math.min(base * Math.pow(factor, attempt - 1), max);
}

/**
 * Server-requested backoff carried on a kosong `APIStatusError` (parsed from
 * the `retry-after` response header). When present and positive it overrides
 * the computed backoff — a server `Retry-After` directive takes precedence
 * over the local exponential delay.
 */
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
