import type { GoalSnapshot } from '#/features/goal/types';

import type { SessionStatusResponse } from './sessionProtocol';
import { LifecycleScope } from '#/app/scopes';
import {
  type IAgentScopeHandle,
  type ISessionScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import {
  IInstantiationService,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { IAgentGoalService } from '#/features/goal/goal';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import { IAgentTowerService } from '#/features/tower/tower';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import {
  getLiveSessionById,
  resumeSessionById,
} from '#/app/sessionManager/sessionLookup';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { ErrorCodes, Error2 } from '#/errors';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentActivityView } from '#/agent/activityView/activityView';

import { ISessionLegacyService } from './sessionLegacy';

export class SessionLegacyService implements ISessionLegacyService {
  declare readonly _serviceBrand: undefined;

  private readonly services: ServicesAccessor;

  constructor(@IInstantiationService instantiation: IInstantiationService) {
    this.services = {
      get: (id) => instantiation.invokeFunction((accessor) => accessor.get(id)),
    };
  }

  private resume(sessionId: string): Promise<ISessionScopeHandle | undefined> {
    return resumeSessionById(this.services, sessionId);
  }

  private async resolveMainAgent(sessionId: string): Promise<IAgentScopeHandle> {
    const session = await this.resume(sessionId);
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const context = await ensureMainAgent(session);
    const handle = session.accessor.get(IAgentLifecycleService).handleOf(context.agentId);
    if (handle === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    return handle;
  }

  async status(sessionId: string): Promise<SessionStatusResponse> {
    const agent = await this.resolveMainAgent(sessionId);
    return this.assembleStatus(sessionId, agent);
  }

  private async assembleStatus(
    sessionId: string,
    agent: IAgentScopeHandle,
  ): Promise<SessionStatusResponse> {
    const profile = agent.accessor.get(IAgentProfileService);
    const tokenCounting = agent.accessor.get(ISessionTokenCountingService);
    const permission = agent.accessor.get(IAgentPermissionModeService);
    const plan = agent.accessor.get(IAgentPlanService);
    const swarm = agent.accessor.get(IAgentSwarmService);
    const tower = agent.accessor.get(IAgentTowerService);

    const model = profile.getModel();
    const capabilities = profile.getModelCapabilities();
    let maxTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
    if (maxTokens === 0 && model === '') {
      maxTokens = resolveDefaultModelContextTokens(agent) ?? 0;
    }
    const tokens = tokenCounting.statusSize(agentContextOf(agent));
    const planData = await plan.status();

    return {
      busy: this.readBusy(sessionId),
      model: model === '' ? undefined : model,
      thinking_level: model === '' ? '' : profile.getEffectiveThinkingLevel(),
      permission: permission.mode,
      plan_mode: planData !== null,
      swarm_mode: swarm.isActive,
      tower_mode: tower.isActive,
      context_tokens: tokens,
      max_context_tokens: maxTokens > 0 ? maxTokens : undefined,
      context_usage: maxTokens > 0 ? Math.min(1, tokens / maxTokens) : undefined,
    };
  }

  private readBusy(sessionId: string): boolean {
    const handle = getLiveSessionById(this.services, sessionId);
    if (handle === undefined) return false;
    const agents = handle.accessor.get(IAgentLifecycleService);
    for (const agent of agents.list()) {
      const agentHandle = agents.handleOf(agent.agentId);
      if (agentHandle === undefined) continue;
      const state = agentHandle.accessor.get(IAgentActivityView).state();
      if (state.turn !== undefined || state.background.length > 0) return true;
    }
    return false;
  }

  async goal(sessionId: string): Promise<GoalSnapshot | null> {
    const agent = await this.resolveMainAgent(sessionId);
    return agent.accessor.get(IAgentGoalService).getGoal().goal;
  }
}

function resolveDefaultModelContextTokens(agent: IAgentScopeHandle): number | undefined {
  const defaultModel = agent.accessor.get(IModelService).getDefaultModel();
  if (defaultModel === undefined || defaultModel.length === 0) return undefined;
  try {
    const capabilities = agent.accessor.get(IModelCatalog).get(defaultModel).capabilities;
    return capabilities.max_input_tokens ?? capabilities.max_context_tokens;
  } catch {
    return undefined;
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionLegacyService,
  SessionLegacyService,
  ScopeActivation.OnScopeCreated,
  'sessionLegacy',
);
