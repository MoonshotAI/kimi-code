/**
 * `turn` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const TurnErrors = {
  codes: {
    TURN_AGENT_BUSY: 'turn.agent_busy',
  },
  retryable: ['turn.agent_busy'],
} as const satisfies ErrorDomain;

registerErrorDomain(TurnErrors);
