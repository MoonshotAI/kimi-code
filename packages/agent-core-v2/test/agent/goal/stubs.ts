/**
 * Shared stubs for goal tests.
 */

import type { IAgentSwarmService } from '#/agent/swarm/swarm';

/**
 * Inert stand-in for `IAgentSwarmService`.
 *
 * Goal tests never exercise swarm behavior, but the test-agent harness
 * instantiates every contributed tool, and `AgentSwarmTool` injects the real
 * `AgentSwarmService` — which self-wires executor veto listeners and pulls
 * in the swarm runtime. Stubbing the service keeps goal tests focused on
 * goal wiring.
 */
export function stubAgentSwarm(): IAgentSwarmService {
  return {
    _serviceBrand: undefined,
    isActive: false,
    enter: () => undefined,
    exit: () => undefined,
  };
}
