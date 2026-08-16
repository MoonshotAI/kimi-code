/**
 * Shared stubs for goal tests.
 */

import type { IAgentSwarmService } from '#/features/swarm/agent/swarm';

export function stubAgentSwarm(): IAgentSwarmService {
  return {
    _serviceBrand: undefined,
    isActive: false,
    enter: () => undefined,
    exit: () => undefined,
  };
}
