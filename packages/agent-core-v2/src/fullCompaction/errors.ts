/**
 * `fullCompaction` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const FullCompactionErrors = {
  codes: {
    COMPACTION_FAILED: 'compaction.failed',
    COMPACTION_UNABLE: 'compaction.unable',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(FullCompactionErrors);
