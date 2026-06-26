/**
 * Base error classes shared by every domain — `KimiError`,
 * `CancellationError`, and related control-flow errors.
 */

import { CoreErrors } from './codes';
import type { ErrorCode } from './codes';

export class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'CancellationError';
  }
}

export function isCancellationError(error: unknown): error is CancellationError {
  return error instanceof CancellationError;
}

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

export interface KimiErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
  readonly name?: string;
}

export class KimiError extends Error {
  readonly code: ErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, message: string, options?: KimiErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = options?.name ?? 'KimiError';
    this.code = code;
    this.details = options?.details;
  }
}

export function isKimiError(error: unknown): error is KimiError {
  return error instanceof KimiError;
}

export class NotImplementedError extends KimiError {
  constructor(feature?: string) {
    super(
      CoreErrors.codes.NOT_IMPLEMENTED,
      feature ? `Not implemented: ${feature}` : 'Not implemented',
    );
    this.name = 'NotImplementedError';
  }
}
