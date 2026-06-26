/**
 * `wireRecord` domain error codes — record persistence failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const WireRecordErrors = {
  codes: {
    RECORDS_WRITE_FAILED: 'records.write_failed',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WireRecordErrors);
