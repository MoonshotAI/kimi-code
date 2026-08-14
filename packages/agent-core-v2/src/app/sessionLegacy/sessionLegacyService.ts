/**
 * `sessionLegacy` domain — `ISessionLegacyService` implementation.
 *
 * Stateless App-scope dispatcher: each method resolves the target session (and
 * its main agent) per call, delegates to the native v2 services, and projects
 * the result into the v1 wire shape. Only `status` (the best-effort status
 * rollup) and `goal` (the current-goal read) live here — the profile route's
 * title/metadata patch and `agent_config` dispatch are composed by kap-server.
 * No business logic is duplicated here.
 */

import type { GoalSnapshot } from '#/agent/goal/types';

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
import { IAgentTokenCountingService } from '#/agent/tokenCounting/tokenCounting';
import { IAgentGoalService } from '#/agent/goal/goal';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPlanService } from '#/features/plan/plan';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentSwarmService } from '#/features/swarm/agent/swarm';
import {
  getLiveSessionById,
  resumeSessionById,
} from '#/app/workspaceLifecycle/sessionLookup';
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
    return ensureMainAgent(session);
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
    const tokenCounting = agent.accessor.get(IAgentTokenCountingService);
    const permission = agent.accessor.get(IAgentPermissionModeService);
    const plan = agent.accessor.get(IAgentPlanService);
    const swarm = agent.accessor.get(IAgentSwarmService);

    const model = profile.getModel();
    const capabilities = profile.getModelCapabilities();
    // An alias that no longer resolves yields UNKNOWN_CAPABILITY whose
    // max_context_tokens is 0 — the "unknown" marker, not a real limit. Only
    // an unbound session falls back to the default model's limit; when the
    // limit stays unknown the field is omitted (never 0), mirroring the WS
    // status push (`readLegacyStatus`).
    let maxTokens = capabilities.max_input_tokens ?? capabilities.max_context_tokens;
    if (maxTokens === 0 && model === '') {
      maxTokens = resolveDefaultModelContextTokens(agent) ?? 0;
    }
    const tokens = tokenCounting.statusSize();
    const planData = await plan.status();

    return {
      busy: this.readBusy(sessionId),
      model: model === '' ? undefined : model,
      thinking_level: model === '' ? '' : profile.getEffectiveThinkingLevel(),
      permission: permission.mode,
      plan_mode: planData !== null,
      swarm_mode: swarm.isActive,
      context_tokens: tokens,
      max_context_tokens: maxTokens > 0 ? maxTokens : undefined,
      context_usage: maxTokens > 0 ? Math.min(1, tokens / maxTokens) : 0,
    };
  }

  private readBusy(sessionId: string): boolean {
    const handle = getLiveSessionById(this.services, sessionId);
    if (handle === undefined) return false;
    for (const agent of handle.accessor.get(IAgentLifecycleService).list()) {
      const state = agent.accessor.get(IAgentActivityView).state();
      if (state.turn !== undefined || state.background.length > 0) return true;
    }
    return false;
  }

  async goal(sessionId: string): Promise<GoalSnapshot | null> {
    const agent = await this.resolveMainAgent(sessionId);
    return agent.accessor.get(IAgentGoalService).getGoal().goal;
  }
}

/**
 * Context limit of the configured default model, or `undefined` when no
 * default model is configured or it does not resolve.
 */
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
