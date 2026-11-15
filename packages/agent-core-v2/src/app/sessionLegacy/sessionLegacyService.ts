import type { GoalSnapshot } from '#/features/goal/types';

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
import { IAgentGoalService } from '#/features/goal/goalService';
import { resumeSessionById } from '#/app/sessionManager/sessionLookup';
import { ErrorCodes, Error2 } from '#/errors';
import { ensureMainAgent } from '#/session/agentLifecycle/mainAgent';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';

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

  async goal(sessionId: string): Promise<GoalSnapshot | null> {
    const agent = await this.resolveMainAgent(sessionId);
    return agent.accessor.get(IAgentGoalService).getGoal().goal;
  }
}

registerScopedService(
  LifecycleScope.App,
  ISessionLegacyService,
  SessionLegacyService,
  ScopeActivation.OnScopeCreated,
  'sessionLegacy',
);
