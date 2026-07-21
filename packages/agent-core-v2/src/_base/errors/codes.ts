/**
 * `errors` domain (cross-cutting) — error-code contract, runtime registry, and
 * metadata backing serialization.
 *
 * Owns the `ErrorDomain` contract every business domain uses to contribute its
 * codes, the registry (`registerErrorDomain` / `errorInfo` / `isErrorCode`) the
 * serializer reads, and the domain-independent core codes (`internal`,
 * `not_implemented`). Domain-owned codes live next to their owning domain and
 * are aggregated into the public `ErrorCodes` const by `#/errors`, which also
 * derives the `ErrorCode` union type from that aggregate — so each domain's
 * `errors.ts` is the single source of truth and there is no central
 * hand-maintained list to keep in sync.
 */

export interface ErrorInfo {
  readonly title: string;
  readonly retryable: boolean;
  readonly public: boolean;
  readonly action?: string;
}

export interface ErrorDomain {
  readonly codes: { readonly [name: string]: string };
  readonly retryable?: ReadonlyArray<string>;
  readonly info?: { readonly [code: string]: ErrorInfo };
}

// Maps each registered code to the `codes` object that contributed it: a
// domain re-registering itself stays idempotent, while two different domains
// claiming the same code fail loudly at registration time.
const registeredCodes = new Map<string, object>();
const retryableCodes = new Set<string>();
const infoOverrides: { [code: string]: ErrorInfo } = {};

export function registerErrorDomain(domain: ErrorDomain): void {
  for (const code of Object.values(domain.codes)) {
    const owner = registeredCodes.get(code);
    if (owner !== undefined && owner !== domain.codes) {
      throw new Error(`error code '${code}' is registered by two different domains`);
    }
    registeredCodes.set(code, domain.codes);
  }
  for (const code of domain.retryable ?? []) {
    retryableCodes.add(code);
  }
  for (const [code, info] of Object.entries(domain.info ?? {})) {
    infoOverrides[code] = info;
  }
}

export function isErrorCode(code: unknown): code is string {
  return typeof code === 'string' && registeredCodes.has(code);
}

export function errorInfo(code: string): ErrorInfo {
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
    VALIDATION_FAILED: 'validation.failed',
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
