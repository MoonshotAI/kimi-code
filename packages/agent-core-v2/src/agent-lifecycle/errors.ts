/**
 * `agent-lifecycle` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const AgentLifecycleErrors = {
  codes: {
    AGENT_NOT_FOUND: 'agent.not_found',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AgentLifecycleErrors);
