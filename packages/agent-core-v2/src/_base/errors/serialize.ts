/**
 * Wire serialization of errors — converts between thrown values and the
 * portable `ErrorPayload` that crosses process / language boundaries.
 */

import { ERROR_INFO, ErrorCodes } from './codes';
import type { ErrorCode } from './codes';
import { KimiError, isCancellationError } from './errors';

export interface ErrorPayload {
  readonly code: ErrorCode;
  readonly message: string;
  readonly name?: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly retryable: boolean;
}

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
  return (
    typeof code === 'string' &&
    Object.prototype.hasOwnProperty.call(ERROR_INFO, code)
  );
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
    retryable: ERROR_INFO[code].retryable,
  };
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (isCancellationError(error)) {
    return makeErrorPayload(ErrorCodes.CANCELED, error.message);
  }
  if (isCodedError(error)) {
    return {
      code: error.code,
      message: error.message,
      name: error.name,
      details: error.details,
      retryable: ERROR_INFO[error.code].retryable,
    };
  }
  if (error instanceof Error) {
    return makeErrorPayload(ErrorCodes.INTERNAL, error.message, { name: error.name });
  }
  return makeErrorPayload(ErrorCodes.INTERNAL, String(error));
}

export function fromErrorPayload(payload: ErrorPayload): KimiError {
  return new KimiError(payload.code, payload.message, {
    name: payload.name,
    details: payload.details,
  });
}
