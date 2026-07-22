/**
 * `wire` domain (L2) — error codes, the `WireError` base class, and the domain
 * registration.
 *
 * Aggregates the wire domain's coded errors: `DuplicateOpError` (thrown by
 * `defineOp` in `op.ts`) and `CycleError` (thrown by the dispatch drain in
 * `wireService.ts`) stay co-located with their throw sites but extend
 * `WireError`; `wire.unknown_record` is constructed here for replay-time
 * reporting of records whose Op type is absent from `OP_REGISTRY`.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, type Error2Options } from '#/_base/errors/errors';

export const WireErrors = {
  codes: {
    WIRE_DUPLICATE_OP: 'wire.duplicate_op',
    WIRE_CYCLE: 'wire.cycle',
    WIRE_UNKNOWN_RECORD: 'wire.unknown_record',
    RECORDS_WRITE_FAILED: 'records.write_failed',
  },
  info: {
    'wire.duplicate_op': {
      title: 'Duplicate wire op type',
      retryable: false,
      public: true,
      action: 'Two ops registered the same type; rename one. This is a build-time bug.',
    },
    'wire.cycle': {
      title: 'Wire dispatch cycle',
      retryable: false,
      public: true,
      action: 'An onChange handler re-dispatches endlessly; break the op cycle.',
    },
    'wire.unknown_record': {
      title: 'Unknown wire record',
      retryable: false,
      public: true,
      action: 'The record was written by a newer version; upgrade or drop it.',
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
