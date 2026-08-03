/**
 * `agentLifecycle` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AgentLifecycleErrors = {
  codes: {
    AGENT_NOT_FOUND: 'agent.not_found',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AgentLifecycleErrors);
