/**
 * Shared stubs for goal tests.
 */

import type { IAgentSwarmService } from '#/agent/swarm/swarm';

/**
 * Inert stand-in for `IAgentSwarmService`.
 *
 * Goal tests never exercise swarm behavior, but the test-agent harness
 * instantiates every contributed tool, and `AgentSwarmTool` injects the real
 * `AgentSwarmService` — whose constructor registers an executor hook ordered
 * `before: 'permission'` and therefore throws while the permission gate hook
 * does not exist yet (the gate itself transitively constructs the swarm
 * service through the policy chain). Stubbing the service keeps goal tests
 * focused on goal wiring.
 */
export function stubAgentSwarm(): IAgentSwarmService {
  return {
    _serviceBrand: undefined,
    isActive: false,
    enter: () => undefined,
    exit: () => undefined,
  };
}
