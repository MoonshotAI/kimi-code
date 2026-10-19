import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const WireErrors = {
  codes: {
    WIRE_UNKNOWN_RECORD: 'wire.unknown_record',
    WIRE_MIGRATION_MISSING: 'wire.migration_missing',
    RECORDS_WRITE_FAILED: 'records.write_failed',
  },
  info: {
    'wire.unknown_record': {
      title: 'Unknown wire record',
      retryable: false,
      public: true,
      action: 'The record was written by a newer version; upgrade or drop it.',
    },
    'wire.migration_missing': {
      title: 'Wire migration missing',
      retryable: false,
      public: true,
      action: 'The wire file predates the supported migration chain; start a new session.',
    },
    'records.write_failed': {
      title: 'Wire journal write failed',
      retryable: false,
      public: true,
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WireErrors);

export type WireErrorCode = (typeof WireErrors.codes)[keyof typeof WireErrors.codes];

export class WireError extends Error2 {
  constructor(code: WireErrorCode, message: string, options?: Error2Options) {
    super(code, message, options);
    this.name = 'WireError';
  }
}
