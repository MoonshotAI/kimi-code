import {
  ErrorCodes,
  Error2,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentSwarmService,
  IAgentToolPolicyService,
  IAgentTowerService,
  ProfileError,
  resumeSessionById,
  towerEnterFailureMessage,
  type IAgentScopeHandle,
  type PermissionMode,
  type PromptLaunchMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { SessionAgentConfigUpdate } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { ensureMainAgent } from '../transport/mainAgent';

export async function applyPromptLaunchMode(
  agent: Pick<IAgentScopeHandle, 'accessor'>,
  mode: PromptLaunchMode,
  objective: string,
): Promise<void> {
  const plan = agent.accessor.get(IAgentPlanService);
  switch (mode) {
    case 'plan':
      await agent.accessor.get(IAgentTowerService).exit();
      if ((await plan.status()) === null) await plan.enter();
      return;
    case 'swarm': {
      await agent.accessor.get(IAgentTowerService).exit();
      const swarm = agent.accessor.get(IAgentSwarmService);
      if (!swarm.isActive) swarm.enter('manual');
      return;
    }
    case 'goal':
      if ((await plan.status()) !== null) plan.exit();
      await agent.accessor.get(IAgentGoalService).createGoal({ objective });
      return;
  }
}

async function rejectProfileErrors(apply: () => Promise<unknown>): Promise<void> {
  try {
    await apply();
  } catch (error) {
    if (error instanceof ProfileError) throw new Error2(ErrorCodes.REQUEST_INVALID, error.message);
    throw error;
  }
}

export async function applySessionAgentConfig(
  core: Scope,
  sessionId: string,
  agentConfig: SessionAgentConfigUpdate,
): Promise<void> {
  const session = await resumeSessionById(core.accessor, sessionId);
  if (session === undefined) {
    throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
  }
  const agent = await ensureMainAgent(session);

  const profile = agent.accessor.get(IAgentProfileService);
  const model = agentConfig.model === '' ? undefined : agentConfig.model;
  const profileName = agentConfig.profile;
  const rebound = profileName !== undefined && profileName !== profile.data().profileName;
  if (rebound) {
    await rejectProfileErrors(() => profile.bind({
      profile: profileName,
      model,
      thinking: agentConfig.thinking,
      strictThinking: agentConfig.thinking !== undefined,
    }));
  }
  if (model !== undefined) {
    await profile.setModel(model);
  }
  if (agentConfig.thinking !== undefined && !rebound) {
    profile.setThinking(agentConfig.thinking);
  }
  if (agentConfig.disabled_tools !== undefined) {
    const disabledTools = agentConfig.disabled_tools;
    await rejectProfileErrors(() => agent.accessor.get(IAgentToolPolicyService).setSessionDisabledTools(disabledTools));
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
