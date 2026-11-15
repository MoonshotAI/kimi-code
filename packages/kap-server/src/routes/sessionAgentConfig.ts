import {
  DEFAULT_AGENT_PROFILE_NAME,
  ErrorCodes,
  Error2,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentLoopService,
  IAgentPlanService,
  IAgentSwarmService,
  IAgentTowerService,
  IModelCatalog,
  IModelService,
  IProviderService,
  resumeSessionById,
  towerEnterFailureMessage,
  type BindAgentInput,
  type ISessionScopeHandle,
  type PermissionMode,
  type Scope,
} from '@moonshot-ai/agent-core-v2';
import type { SessionAgentConfigPartial } from '@moonshot-ai/agent-core-v2/app/sessionLegacy/sessionProtocol';

import { ErrorCode } from '../protocol/error-codes';
import { ensureMainAgent } from '../transport/mainAgent';

export const agentConfigErrors = {
  [ErrorCode.AUTH_MODEL_NOT_RESOLVED]: {},
  [ErrorCode.GOAL_ALREADY_EXISTS]: {},
  [ErrorCode.GOAL_NOT_FOUND]: {},
  [ErrorCode.GOAL_STATUS_INVALID]: {},
  [ErrorCode.GOAL_NOT_RESUMABLE]: {},
  [ErrorCode.GOAL_OBJECTIVE_EMPTY]: {},
  [ErrorCode.GOAL_OBJECTIVE_TOO_LONG]: {},
  [ErrorCode.GOAL_UNSUPPORTED_AGENT]: {},
} as const;

export async function creationMainAgentBinding(
  core: Scope,
  agentConfig: SessionAgentConfigPartial & { readonly profile?: string },
): Promise<BindAgentInput | undefined> {
  const model =
    agentConfig.model !== undefined && agentConfig.model !== ''
      ? agentConfig.model
      : await bindableDefaultModel(core);
  if (model === undefined) {
    if (agentConfig.profile !== undefined || agentConfig.thinking !== undefined) {
      throw sessionModelMissing();
    }
    return undefined;
  }
  return {
    profile: agentConfig.profile ?? DEFAULT_AGENT_PROFILE_NAME,
    model,
    thinking: agentConfig.thinking,
    strictThinking: agentConfig.thinking !== undefined,
  };
}

async function bindableDefaultModel(core: Scope): Promise<string | undefined> {
  const models = core.accessor.get(IModelService);
  await Promise.all([models.ready, core.accessor.get(IProviderService).ready]);
  const model = models.getDefaultModel();
  if (model === undefined || model === '') return undefined;
  try {
    core.accessor.get(IModelCatalog).get(model);
    return model;
  } catch {
    return undefined;
  }
}

export function applyThinking(loop: IAgentLoopService, level: string): void {
  if (!loop.hasModel()) throw sessionModelMissing();
  loop.setThinking(level);
}

function sessionModelMissing(): Error2 {
  return new Error2(
    ErrorCodes.AUTH_MODEL_NOT_RESOLVED,
    'no model is available for the session; configure a model first',
  );
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
  await applyAgentConfigToSession(session, agentConfig);
}

export async function applyAgentConfigToSession(
  session: ISessionScopeHandle,
  agentConfig: SessionAgentConfigPartial,
): Promise<void> {
  const agent = await ensureMainAgent(session);

  const loop = agent.accessor.get(IAgentLoopService);
  if (agentConfig.model !== undefined && agentConfig.model !== '') {
    await loop.setModel(agentConfig.model);
  }
  if (agentConfig.thinking !== undefined) {
    applyThinking(loop, agentConfig.thinking);
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
