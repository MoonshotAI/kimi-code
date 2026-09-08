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
