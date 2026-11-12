import {
  ErrorCodes,
  Error2,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPlanService,
  IAgentSwarmService,
  IAgentTowerService,
  resumeSessionById,
  towerEnterFailureMessage,
  type ISessionScopeHandle,
  type PermissionMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { SessionAgentConfigPartial } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { ErrorCode } from '../protocol/error-codes';
import { ensureMainAgent } from '../transport/mainAgent';

export const agentConfigErrors = {
  [ErrorCode.GOAL_ALREADY_EXISTS]: {},
  [ErrorCode.GOAL_NOT_FOUND]: {},
  [ErrorCode.GOAL_STATUS_INVALID]: {},
  [ErrorCode.GOAL_NOT_RESUMABLE]: {},
  [ErrorCode.GOAL_OBJECTIVE_EMPTY]: {},
  [ErrorCode.GOAL_OBJECTIVE_TOO_LONG]: {},
  [ErrorCode.GOAL_UNSUPPORTED_AGENT]: {},
} as const;

export async function applySessionAgentConfig(
  core: Scope,
  sessionId: string,
  agentConfig: SessionAgentConfigPartial,
): Promise<void> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  await applyAgentConfigToSession(session, agentConfig);
}

export async function applyAgentConfigToSession(
  session: ISessionScopeHandle,
  agentConfig: SessionAgentConfigPartial,
): Promise<void> {
  const agent = await ensureMainAgent(session);

  const profile = agent.accessor.get(IAgentLoopService);
  if (agentConfig.model !== undefined && agentConfig.model !== '') {
    await agent.accessor.get(IAgentLoopService).setModel(agentConfig.model);
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
  if (agentConfig.tower_mode !== undefined) {
    const tower = agent.accessor.get(IAgentTowerService);
    if (agentConfig.tower_mode) {
      const result = await tower.enter(agentConfig.tower_base);
      if (!result.entered) {
        throw new Error2(
          ErrorCodes.SESSION_TOWER_MODE_INVALID,
          towerEnterFailureMessage(result),
        );
      }
    } else {
      await tower.exit();
    }
  }
  if (agentConfig.goal_objective !== undefined) {
    await agent.accessor
      .get(IAgentGoalService)
      .createGoal({ objective: agentConfig.goal_objective });
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
