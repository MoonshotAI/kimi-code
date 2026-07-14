/**
 * Base error classes shared by every domain — `Error2` and related
 * control-flow errors.
 */

import { CoreErrors } from './codes';
import type { ErrorCode } from './codes';

export class ExpectedError extends Error {
  readonly isExpected = true;
}

export class ErrorNoTelemetry extends Error {
  constructor(message?: string) {
    super(message);
    this.name = 'CodeExpectedError';
  }

  static fromError(error: Error): ErrorNoTelemetry {
    const wrapped = new ErrorNoTelemetry(error.message);
    wrapped.stack = error.stack;
    return wrapped;
  }

  static isErrorNoTelemetry(error: unknown): error is ErrorNoTelemetry {
    return error instanceof Error && error.name === 'CodeExpectedError';
  }
}

export class BugIndicatingError extends Error {
  constructor(message?: string) {
    super(message ?? 'An unexpected bug occurred.');
    this.name = 'BugIndicatingError';
  }
}

export interface Error2Options {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  readonly name?: string;
}

export class Error2 extends Error {
  readonly code: ErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options?: Error2Options) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = options?.name ?? 'Error2';
    this.code = code;
    this.details = options?.details;
  }
}

export function isError2(error: unknown): error is Error2 {
  return error instanceof Error2;
}

export function unwrapErrorCause(error: unknown): unknown {
  let current = error;
  while (current instanceof Error2 && current.cause !== undefined) {
    current = current.cause;
  }
  return current;
}

export class NotImplementedError extends Error2 {
  constructor(feature?: string) {
    super(
      CoreErrors.codes.NOT_IMPLEMENTED,
      feature ? `Not implemented: ${feature}` : 'Not implemented',
    );
    this.name = 'NotImplementedError';
  }
}
