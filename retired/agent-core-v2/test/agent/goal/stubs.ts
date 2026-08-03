/**
 * Shared stubs for goal tests.
 */

import type { IAgentSwarmService } from '#/agent/swarm/swarm';
import type { IAgentGoalJudgeService, JudgeVerdict } from '#/agent/goal/judge/goalJudgeService';

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

/**
 * Stub judge that approves every goal completion request.
 *
 * The real `AgentGoalJudgeService` spawns a subagent for independent
 * verification, which doesn't work in unit/integration tests without
 * full subagent infrastructure. This stub returns `{ ok: true }` for
 * all evaluations so that `UpdateGoal` tool tests can complete goals
 * without needing a subagent.
 */
export function stubJudge(verdict?: Partial<JudgeVerdict>): IAgentGoalJudgeService {
  return {
    _serviceBrand: undefined,
    evaluate: async () => ({
      ok: true,
      reason: 'Approved by stub judge.',
      ...verdict,
    }),
  };
}