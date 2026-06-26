/**
 * Wire serialization of errors — converts between thrown values and the
 * portable `ErrorPayload` that crosses process / language boundaries.
 */

import { CoreErrors, errorInfo, isErrorCode } from './codes';
import type { ErrorCode } from './codes';
import { KimiError, isCancellationError } from './errors';

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
}

export type KimiErrorPayload = ErrorPayload;

export interface CodedErrorShape {
  readonly code: ErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

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
  if (isCancellationError(error)) {
    return makeErrorPayload(CoreErrors.codes.INTERNAL, error.message);
  }
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

export const toKimiErrorPayload = toErrorPayload;

export function fromErrorPayload(payload: ErrorPayload): KimiError {
  return new KimiError(payload.code, payload.message, {
    name: payload.name,
    details: payload.details,
  });
}
