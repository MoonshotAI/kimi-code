import type { KimiErrorCode } from './codes';

export interface KimiErrorOptions {
  /** JSON-serializable structured details. */
  readonly details?: Record<string, unknown>;
  /** Original error or value. Local-only; never serialized to the wire. */
  readonly cause?: unknown;
}

/**
 * The single Kimi error class.
 *
 * Discrimination is always by `code`. Cross-process consumers receive
 * `KimiErrorPayload` and must branch on `code` rather than class identity.
 */
export class KimiError extends Error {
  readonly code: KimiErrorCode;
  readonly details?: Record<string, unknown>;
  override readonly cause?: unknown;

  constructor(code: KimiErrorCode, message: string, options: KimiErrorOptions = {}) {
    super(message);
    this.name = 'KimiError';
    this.code = code;
    this.details = options.details;
    this.cause = options.cause;
  }
}
