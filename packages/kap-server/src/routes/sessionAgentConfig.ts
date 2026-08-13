/**
 * `agent_config` patch dispatch for `POST /sessions/{session_id}/profile`.
 *
 * The `agent_config` body field is a wire-to-native translation, not a v1-only
 * projection, so it lives at the server edge alongside the other routes that
 * call the native v2 services directly (`fork` / `compact` / `undo` / `abort`)
 * instead of inside `ISessionLegacyService`. The helper resumes the session
 * (cold-load if needed), resolves its main agent, and fans each present field
 * out to the owning Agent-scope service, preserving the per-field
 * apply-only-when-set semantics and the plan/swarm idempotency guards.
 */

import {
  ErrorCodes,
  Error2,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentSwarmService,
  resumeSessionById,
  type PermissionMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { SessionAgentConfigPartial } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { ensureMainAgent } from '../transport/mainAgent';

export async function applySessionAgentConfig(
  core: Scope,
  sessionId: string,
  agentConfig: SessionAgentConfigPartial,
): Promise<void> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const agent = await ensureMainAgent(session);

  const profile = agent.accessor.get(IAgentProfileService);
  if (agentConfig.model !== undefined && agentConfig.model !== '') {
    await profile.setModel(agentConfig.model);
  }
  if (agentConfig.thinking !== undefined) {
    profile.setThinking(agentConfig.thinking);
  }
  if (agentConfig.permission_mode !== undefined) {
    agent.accessor
      .get(IAgentLifecycleService)
      .broadcastPermissionMode(agentConfig.permission_mode as PermissionMode);
  }
  if (agentConfig.plan_mode !== undefined) {
    const plan = agent.accessor.get(IAgentPlanService);
    const active = (await plan.status()) !== null;
    if (active !== agentConfig.plan_mode) {
      if (agentConfig.plan_mode) await plan.enter();
      else plan.exit();
    }
  }
  if (agentConfig.swarm_mode !== undefined) {
    const swarm = agent.accessor.get(IAgentSwarmService);
    if (swarm.isActive !== agentConfig.swarm_mode) {
      if (agentConfig.swarm_mode) swarm.enter('manual');
      else swarm.exit();
    }
  }
  if (agentConfig.goal_objective !== undefined) {
    await agent.accessor.get(IAgentGoalService).createGoal({ objective: agentConfig.goal_objective });
  }
  if (agentConfig.goal_control !== undefined) {
    const goal = agent.accessor.get(IAgentGoalService);
    switch (agentConfig.goal_control) {
      case 'pause':
        await goal.pauseGoal({});
        break;
      case 'resume':
        await goal.resumeGoal({ continueIfPaused: true, continueIfBlocked: true });
        break;
      case 'cancel':
        await goal.cancelGoal({});
        break;
    }
  }
}
