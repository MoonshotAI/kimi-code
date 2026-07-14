/**
 * `errors` domain (cross-cutting) — wire serialization of thrown values.
 *
 * Converts between thrown values and the portable `ErrorPayload` that crosses
 * process / language boundaries, recursively through the `cause` chain. Knows
 * only coded errors and the core codes: business-domain translation (e.g.
 * provider API errors) happens at the owning domain's boundary before errors
 * reach this layer, so `_base/errors` never imports a business domain.
 */

import { CoreErrors, errorInfo, isErrorCode } from './codes';
import type { ErrorCode } from './codes';
import { Error2 } from './errors';

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
  readonly cause?: ErrorPayload;
}

export type KimiErrorPayload = ErrorPayload;

export interface CodedErrorShape {
  readonly code: ErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

const MAX_CAUSE_DEPTH = 8;

export function isCodedError(error: unknown): error is CodedErrorShape {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const code = (error as { readonly code?: unknown }).code;
  return isErrorCode(code);
}

export function makeErrorPayload(
  code: ErrorCode,
  message: string,
  options?: {
    readonly details?: Readonly<Record<string, unknown>>;
    readonly name?: string;
  },
): ErrorPayload {
  return {
    code,
    message,
    name: options?.name,
    details: options?.details,
    retryable: errorInfo(code).retryable,
  };
}

export function toErrorPayload(error: unknown): ErrorPayload {
  return toErrorPayloadAtDepth(error, 0);
}

function toErrorPayloadAtDepth(error: unknown, depth: number): ErrorPayload {
  const payload = toShallowErrorPayload(error);
  if (depth >= MAX_CAUSE_DEPTH) {
    return payload;
  }
  const cause = readErrorCause(error);
  if (cause === undefined) {
    return payload;
  }
  return { ...payload, cause: toErrorPayloadAtDepth(cause, depth + 1) };
}

function toShallowErrorPayload(error: unknown): ErrorPayload {
  if (isCodedError(error)) {
    return {
      code: error.code,
      message: error.message,
      name: error.name,
      details: error.details,
      retryable: errorInfo(error.code).retryable,
    };
  }
  if (error instanceof Error) {
    return makeErrorPayload(CoreErrors.codes.INTERNAL, error.message, { name: error.name });
  }
  return makeErrorPayload(CoreErrors.codes.INTERNAL, String(error));
}

function readErrorCause(error: unknown): unknown {
  if (error === null || typeof error !== 'object') {
    return undefined;
  }
  return (error as { readonly cause?: unknown }).cause;
}

export const toKimiErrorPayload = toErrorPayload;

export function fromErrorPayload(payload: ErrorPayload): Error2 {
  return new Error2(payload.code, payload.message, {
    name: payload.name,
    details: payload.details,
    cause: payload.cause === undefined ? undefined : fromErrorPayload(payload.cause),
  });
}
