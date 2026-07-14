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

export type ErrorCode = KimiErrorCode;

export interface ErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
}

export interface ErrorDomain {
  readonly codes: { readonly [name: string]: ErrorCode };
  readonly retryable?: ReadonlyArray<ErrorCode>;
  readonly info?: { readonly [code: string]: ErrorInfo };
}

const registeredCodes = new Set<ErrorCode>();
const retryableCodes = new Set<ErrorCode>();
const infoOverrides: { [code: string]: ErrorInfo } = {};

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
