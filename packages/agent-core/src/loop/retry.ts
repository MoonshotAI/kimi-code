import { sleep } from '@antfu/utils';

import type { Logger } from '#/logging/types';

import { abortable } from '../utils/abort';
import type { LoopEventDispatcher } from './events';
import { isAbortError } from './errors';
import type { LLM, LLMChatParams, LLMChatResponse } from './llm';

export const DEFAULT_MAX_RETRY_ATTEMPTS = 3;

const BASE_DELAY_MS = 500;
// Per-attempt backoff cap (32s). With the default 3 attempts the ramp
// (0.5s, 1s) never reaches the cap, so interactive runs are unaffected; it
// only matters for high-attempt configs (e.g. eval harnesses with
// `max_retries_per_step = 10`), where it lets retries ride out multi-minute
// provider overload instead of giving up after a few seconds of backoff.
const MAX_DELAY_MS = 32_000;
const RETRY_FACTOR = 2;
// Up to 25% jitter on top of the exponential base to avoid herd retries.
const JITTER_FACTOR = 0.25;

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

      // A server `Retry-After` (carried on the error) overrides the computed
      // backoff. The chosen delay is what gets reported on the
      // `step.retrying` event via `delayMs` either way.
      const delayMs = readRetryAfterMs(error) ?? delays[attempt - 1] ?? 0;
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

function logRequestFailure(
  input: ChatWithRetryInput,
  error: unknown,
  attempt: number,
  maxAttempts: number,
): void {
  if (isAbortError(error) || input.params.signal.aborted) return;
  input.log?.warn('llm request failed', {
    turnStep: `${input.turnId}.${String(input.currentStep)}`,
    attempt: `${String(attempt)}/${String(maxAttempts)}`,
    model: input.llm.modelName,
    ...retryErrorFields(error),
  });
}

function paramsForAttempt(
  input: ChatWithRetryInput,
  attempt: number,
  maxAttempts: number,
): LLMChatParams {
  const turnStep = `${input.turnId}.${String(input.currentStep)}`;
  // Preserve caller-set fields (e.g. the strict-resend projection marker);
  // only the per-attempt turnStep/attempt pair is owned here.
  return {
    ...input.params,
    requestLogFields:
      attempt === 1
        ? { ...input.params.requestLogFields, turnStep }
        : {
            ...input.params.requestLogFields,
            turnStep,
            attempt: `${String(attempt)}/${String(maxAttempts)}`,
          },
  };
}

export function retryBackoffDelays(maxAttempts: number): number[] {
  // For attempt (1-based) the base delay is min(500ms * 2^(attempt-1), 32s),
  // plus up to 25% jitter. Index i here is 0-based, so attempt = i + 1.
  const count = Math.max(maxAttempts - 1, 0);
  const delays: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = Math.min(BASE_DELAY_MS * Math.pow(RETRY_FACTOR, i), MAX_DELAY_MS);
    delays.push(base + Math.random() * JITTER_FACTOR * base);
  }
  return delays;
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
