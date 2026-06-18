import {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  isContextOverflowStatusError,
} from '@moonshot-ai/kosong';

import { ErrorCodes, isKimiError, type KimiErrorPayload } from '#/errors';

export type TelemetryMode = 'agent' | 'plan';
export type TelemetryModeResolver = TelemetryMode | (() => TelemetryMode);

export function resolveTelemetryMode(mode: TelemetryModeResolver | undefined): TelemetryMode | undefined {
  return typeof mode === 'function' ? mode() : mode;
}

export interface ApiErrorClassification {
  readonly errorType: string;
  readonly statusCode?: number;
}

/**
 * Classify a provider/API error into a stable `errorType` for telemetry.
 *
 * - When `error` is a native kosong `ChatProviderError` subclass (e.g.
 *   `APIStatusError`, `APIConnectionError`), `summary` may be omitted — the
 *   status code / `instanceof` checks carry all the information. This is the
 *   `llm_request` path inside `KosongLLM`.
 * - When `error` is a `KimiError`, its `code` and `details.statusCode` are
 *   recognized directly, so the `llm_request` path can classify wrapped OAuth
 *   errors without re-summarizing them.
 * - When `error` is an already-serialized payload (the turn-level `api_error`
 *   path, where the error has been summarized), pass `summary` so the error
 *   code (`PROVIDER_RATE_LIMIT`, `PROVIDER_AUTH_ERROR`, `CONTEXT_OVERFLOW`)
 *   can be recognized; otherwise classification falls back to `'other'`.
 */
export function classifyApiError(
  error: unknown,
  summary?: KimiErrorPayload | undefined,
): ApiErrorClassification {
  const errorCode = isKimiError(error) ? error.code : summary?.code;
  const statusCode = apiStatusCode(error) ?? kimiErrorStatusCode(error) ?? summaryStatusCode(summary);
  if (statusCode !== undefined) {
    if (statusCode === 429) return { errorType: 'rate_limit', statusCode };
    if (statusCode === 401 || statusCode === 403) return { errorType: 'auth', statusCode };
    if (statusCode >= 500) return { errorType: '5xx_server', statusCode };
    if (isContextOverflowStatusError(statusCode, summary?.message ?? errorMessage(error))) {
      return { errorType: 'context_overflow', statusCode };
    }
    if (statusCode >= 400) return { errorType: '4xx_client', statusCode };
    return { errorType: 'api', statusCode };
  }

  if (errorCode === ErrorCodes.PROVIDER_RATE_LIMIT) return { errorType: 'rate_limit' };
  if (errorCode === ErrorCodes.PROVIDER_AUTH_ERROR || errorCode === ErrorCodes.AUTH_LOGIN_REQUIRED) {
    return { errorType: 'auth' };
  }
  if (errorCode === ErrorCodes.CONTEXT_OVERFLOW) return { errorType: 'context_overflow' };
  if (isApiConnectionError(error, summary)) return { errorType: 'network' };
  if (isApiTimeoutError(error, summary)) return { errorType: 'timeout' };
  if (isApiEmptyResponseError(error, summary)) return { errorType: 'empty_response' };
  return { errorType: 'other' };
}

function apiStatusCode(error: unknown): number | undefined {
  if (error instanceof APIStatusError) {
    const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
    return typeof statusCode === 'number' ? statusCode : undefined;
  }
  if (typeof error !== 'object' || error === null) return undefined;
  const statusCode = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof statusCode === 'number') return statusCode;
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function summaryStatusCode(summary: KimiErrorPayload | undefined): number | undefined {
  const statusCode = summary?.details?.['statusCode'];
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function kimiErrorStatusCode(error: unknown): number | undefined {
  if (!isKimiError(error)) return undefined;
  const statusCode = error.details?.['statusCode'];
  return typeof statusCode === 'number' ? statusCode : undefined;
}

function isApiConnectionError(error: unknown, summary: KimiErrorPayload | undefined): boolean {
  return error instanceof APIConnectionError || summary?.name === 'APIConnectionError';
}

function isApiTimeoutError(error: unknown, summary: KimiErrorPayload | undefined): boolean {
  return (
    error instanceof APITimeoutError ||
    summary?.name === 'APITimeoutError' ||
    summary?.name === 'TimeoutError'
  );
}

function isApiEmptyResponseError(error: unknown, summary: KimiErrorPayload | undefined): boolean {
  return error instanceof APIEmptyResponseError || summary?.name === 'APIEmptyResponseError';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Coerce a string turn id into a number when it is exactly integer-shaped
 * (e.g. `"0"` → `0`); otherwise keep the original string. Lets telemetry emit
 * a numeric `turn_id` for the common case while tolerating non-numeric ids.
 */
export function telemetryTurnId(turnId: string | undefined): number | string | undefined {
  if (turnId === undefined) return undefined;
  const numeric = Number(turnId);
  return Number.isInteger(numeric) && String(numeric) === turnId ? numeric : turnId;
}
