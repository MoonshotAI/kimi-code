/**
 * `agentLifecycle` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const AgentLifecycleErrors = {
  codes: {
    AGENT_NOT_FOUND: 'agent.not_found',
    AGENT_ALREADY_EXISTS: 'agent.already_exists',
    AGENT_ALREADY_RUNNING: 'agent.already_running',
    AGENT_NOT_A_SUBAGENT: 'agent.not_a_subagent',
    AGENT_NOT_OWNED: 'agent.not_owned',
    AGENT_TYPE_NOT_ALLOWED: 'agent.type_not_allowed',
    AGENT_MAX_TOKENS_EXCEEDED: 'agent.max_tokens_exceeded',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AgentLifecycleErrors);
