/**
 * `usage` domain error codes — invalid persisted usage records.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const UsageErrors = {
  codes: {
    TURN_ID_CONFLICT: 'usage.turn_id_conflict',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(UsageErrors);
