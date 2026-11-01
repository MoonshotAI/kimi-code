import {
  ErrorCodes,
  Error2,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentSwarmService,
  IAgentTowerService,
  resumeSessionById,
  towerEnterFailureMessage,
  type IAgentScopeHandle,
  type PermissionMode,
  type PromptLaunchMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { SessionAgentConfigPartial } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { ensureMainAgent } from '../transport/mainAgent';

type SessionMode = 'plan' | 'swarm' | 'tower' | 'goal';

const MODE_CONFLICTS: Record<SessionMode, readonly SessionMode[]> = {
  plan: ['tower'],
  swarm: ['tower'],
  tower: ['plan', 'swarm'],
  goal: ['tower', 'plan'],
};

async function activeModes(agent: Pick<IAgentScopeHandle, 'accessor'>): Promise<Set<SessionMode>> {
  const modes = new Set<SessionMode>();
  if ((await agent.accessor.get(IAgentPlanService).status()) !== null) modes.add('plan');
  if (agent.accessor.get(IAgentSwarmService).isActive) modes.add('swarm');
  if (agent.accessor.get(IAgentTowerService).isActive) modes.add('tower');
  return modes;
}

function assertModesCompatible(requested: Iterable<SessionMode>, modes: ReadonlySet<SessionMode>): void {
  for (const mode of requested) {
    const conflict = MODE_CONFLICTS[mode].find((other) => modes.has(other));
    if (conflict !== undefined) {
      throw new Error2(
        ErrorCodes.SESSION_MODE_CONFLICT,
        `${mode} mode is not available while ${conflict} mode is on`,
        { details: { requested: mode, conflict } },
      );
    }
  }
}

export async function applyPromptLaunchMode(
  agent: Pick<IAgentScopeHandle, 'accessor'>,
  mode: PromptLaunchMode,
  objective: string,
): Promise<void> {
  const modes = await activeModes(agent);
  assertModesCompatible([mode], modes);
  switch (mode) {
    case 'plan':
      if (!modes.has('plan')) await agent.accessor.get(IAgentPlanService).enter();
      return;
    case 'swarm':
      if (!modes.has('swarm')) agent.accessor.get(IAgentSwarmService).enter('manual');
      return;
    case 'goal':
      await agent.accessor.get(IAgentGoalService).createGoal({ objective });
      return;
  }
}

async function assertConfigModesCompatible(
  agent: Pick<IAgentScopeHandle, 'accessor'>,
  agentConfig: SessionAgentConfigPartial,
): Promise<void> {
  const toggles: ReadonlyArray<readonly [SessionMode, boolean | undefined]> = [
    ['plan', agentConfig.plan_mode],
    ['swarm', agentConfig.swarm_mode],
    ['tower', agentConfig.tower_mode],
    ['goal', agentConfig.goal_objective === undefined ? undefined : true],
  ];
  if (!toggles.some(([, on]) => on === true)) return;
  const modes = await activeModes(agent);
  for (const [mode, on] of toggles) {
    if (on === false) modes.delete(mode);
  }
  const requested = toggles.filter(([mode, on]) => on === true && !modes.has(mode)).map(([mode]) => mode);
  for (const mode of requested) modes.add(mode);
  assertModesCompatible(requested, modes);
}

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
  await assertConfigModesCompatible(agent, agentConfig);

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
