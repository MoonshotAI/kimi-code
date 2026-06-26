/**
 * `errors` domain (cross-cutting) — error-code contract, runtime registry, and
 * metadata backing serialization.
 *
 * Owns the `ErrorDomain` contract every business domain uses to contribute its
 * codes, the registry (`registerErrorDomain` / `errorInfo` / `isErrorCode`) the
 * serializer reads, and the domain-independent core codes (`internal`,
 * `not_implemented`). Domain-owned codes live next to their owning domain and
 * are aggregated into the public `ErrorCodes` const by `#/errors`.
 */

import type { KimiErrorCode } from '@moonshot-ai/protocol';

/** Wire-stable code carried by every `KimiError`. Sourced from the protocol. */
export type ErrorCode = KimiErrorCode;

export interface ErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
}

/**
 * A domain's error contribution: the `codes` const (name → wire code) plus the
 * optional retryable list and per-code human-facing overrides. Every value in
 * `codes` must be a protocol-known `ErrorCode`.
 */
export interface ErrorDomain {
  readonly codes: { readonly [name: string]: ErrorCode };
  readonly retryable?: ReadonlyArray<ErrorCode>;
  readonly info?: { readonly [code: string]: ErrorInfo };
}

const registeredCodes = new Set<ErrorCode>();
const retryableCodes = new Set<ErrorCode>();
const infoOverrides: { [code: string]: ErrorInfo } = {};

/**
 * Merge a domain's error contribution into the runtime registry. Each domain's
 * error module calls this at load; re-registering an identical code is a no-op.
 */
export function registerErrorDomain(domain: ErrorDomain): void {
  for (const code of Object.values(domain.codes)) {
    registeredCodes.add(code);
  }
  for (const code of domain.retryable ?? []) {
    retryableCodes.add(code);
  }
  for (const [code, info] of Object.entries(domain.info ?? {})) {
    infoOverrides[code] = info;
  }
}

export function isErrorCode(code: unknown): code is ErrorCode {
  return typeof code === 'string' && registeredCodes.has(code as ErrorCode);
}

export function errorInfo(code: ErrorCode): ErrorInfo {
  const override = infoOverrides[code];
  if (override !== undefined) return override;
  return {
    title: code,
    retryable: retryableCodes.has(code),
    public: true,
  };
}

/** Domain-independent codes shared by every consumer. */
export const CoreErrors = {
  codes: {
    INTERNAL: 'internal',
    NOT_IMPLEMENTED: 'not_implemented',
  },
  info: {
    internal: {
      title: 'Internal error',
      retryable: false,
      public: true,
      action: 'Inspect logs or report the issue with diagnostics.',
    },
    not_implemented: {
      title: 'Not implemented',
      retryable: false,
      public: true,
      action: 'This feature is not implemented yet.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(CoreErrors);
