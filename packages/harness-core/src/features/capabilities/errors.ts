export const CAPABILITY_ERROR_CODES = {
  NOT_FOUND: 'capability.not_found',
  UNSUPPORTED: 'capability.unsupported',
  INSTALL_IN_PROGRESS: 'capability.install_in_progress',
} as const;

export type CapabilityErrorCode = (typeof CAPABILITY_ERROR_CODES)[keyof typeof CAPABILITY_ERROR_CODES];

export interface CapabilityErrorOptions {
  readonly details?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class CapabilityError extends Error {
  readonly code: CapabilityErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: CapabilityErrorCode, message: string, options?: CapabilityErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'CapabilityError';
    this.code = code;
    this.details = options?.details;
  }
}
