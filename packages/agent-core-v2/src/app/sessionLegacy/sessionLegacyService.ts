import type { GoalSnapshot } from '#/features/goal/types';

import type { SessionStatusResponse } from './sessionProtocol';
import { LifecycleScope } from '#/app/scopes';
import {
  type ISessionScopeHandle,
  ScopeActivation,
  registerScopedService,
} from '#/_base/di/scope';
import {
  IInstantiationService,
  type ServicesAccessor,
} from '#/_base/di/instantiation';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { AgentGoal } from '#/features/goal/goalAgentRuntime';
import { ISessionPermissionModeService } from '#/session/permissionMode/sessionPermissionMode';
import { ISessionPlanService } from '#/features/plan/sessionPlanService';
import { AgentProfile } from '#/features/profile/profileAgentRuntime';
import { ISessionSwarmAgentService } from '#/features/swarm/session/sessionSwarmAgentService';
import { ISessionTowerService } from '#/features/tower/sessionTowerService';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentHostService } from '#/agent/host/agentHost';
import {
  getLiveSessionById,
  resumeSessionById,
} from '#/app/sessionManager/sessionLookup';
import { IModelCatalog } from '#/kosong/model/catalog';
import { IModelService } from '#/kosong/model/model';
import { ErrorCodes, Error2 } from '#/errors';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentActivityView } from '#/features/activityView/activityViewAgentRuntime';

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

  private async resolveMainAgent(
    sessionId: string,
  ): Promise<{ session: ISessionScopeHandle; agent: AgentContext }> {
    const session = await this.resume(sessionId);
    if (session === undefined) {
      throw new Error2(ErrorCodes.SESSION_NOT_FOUND, `session ${sessionId} does not exist`);
    }
    const context = await ensureMainAgent(session);
    const agent = session.accessor.get(IAgentLifecycleService).get(context.agentId);
    if (agent === undefined) {
      throw new Error2(ErrorCodes.AGENT_NOT_FOUND, 'Main agent was not found');
    }
    return { session, agent };
  }

  async status(sessionId: string): Promise<SessionStatusResponse> {
    const { session, agent } = await this.resolveMainAgent(sessionId);
    return this.assembleStatus(sessionId, session, agent);
  }

  private async assembleStatus(
    sessionId: string,
    session: ISessionScopeHandle,
    agent: AgentContext,
  ): Promise<SessionStatusResponse> {
    const profile = session.accessor
      .get(IAgentLifecycleService)
      .resolve(agent, AgentProfile);
    const tokenCounting = session.accessor.get(ISessionTokenCountingService);
    const permission = session.accessor.get(ISessionPermissionModeService);
    const plan = session.accessor.get(ISessionPlanService).of(agent);
    const swarm = session.accessor.get(ISessionSwarmAgentService).of(agent);
    const tower = session.accessor.get(ISessionTowerService).of(agent);

    const model = profile.model();
    const capabilities = profile.modelCapabilities();
    let maxTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
    if (maxTokens === 0 && model === '') {
      maxTokens = resolveDefaultModelContextTokens(session) ?? 0;
    }
    const tokens = tokenCounting.statusSize(agent);
    const planData = await plan.status();

    return {
      busy: this.readBusy(sessionId),
      model: model === '' ? undefined : model,
      thinking_level: model === '' ? '' : profile.effectiveThinkingLevel(),
      permission: permission.mode(agent),
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
    const hosts = handle.accessor.get(IAgentHostService);
    for (const agent of agents.list()) {
      if (hosts.tryOf(agent) === undefined) continue;
      const state = agents.resolve(agent, AgentActivityView).state();
      if (state.turn !== undefined || state.background.length > 0) return true;
    }
    return false;
  }

  async goal(sessionId: string): Promise<GoalSnapshot | null> {
    const { session, agent } = await this.resolveMainAgent(sessionId);
    return session.accessor
      .get(IAgentLifecycleService)
      .resolve(agent, AgentGoal)
      .getGoal().goal;
  }
}

function resolveDefaultModelContextTokens(session: ISessionScopeHandle): number | undefined {
  const defaultModel = session.accessor.get(IModelService).getDefaultModel();
  if (defaultModel === undefined || defaultModel.length === 0) return undefined;
  try {
    const capabilities = session.accessor.get(IModelCatalog).get(defaultModel).capabilities;
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
