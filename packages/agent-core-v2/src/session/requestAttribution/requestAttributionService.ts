import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';

import {
  type AgentRequestAttribution,
  ISessionRequestAttributionService,
} from './requestAttribution';

export class SessionRequestAttributionService
  extends Service
  implements ISessionRequestAttributionService
{
  declare readonly _serviceBrand: undefined;

  private readonly agents = new Map<string, AgentRequestAttribution>();

  of(agentId: string): AgentRequestAttribution {
    return this.agents.get(agentId) ?? {};
  }

  noteUserInput(agentId: string, userInputId: string): void {
    this.agents.set(agentId, { ...this.of(agentId), userInputId });
  }

  noteActiveRequest(agentId: string, requestId: string | undefined): void {
    this.agents.set(agentId, { ...this.of(agentId), activeRequestId: requestId });
  }

  noteSubagentDispatch(agentId: string, parentAgentId: string): AgentRequestAttribution {
    const current = this.of(agentId);
    const parent = this.of(parentAgentId);
    const next: AgentRequestAttribution = {
      ...current,
      userInputId: parent.userInputId ?? current.userInputId,
      parentRequestId: parent.activeRequestId ?? current.parentRequestId,
    };
    this.agents.set(agentId, next);
    return next;
  }
}

registerScopedService(
  LifecycleScope.Session,
  ISessionRequestAttributionService,
  SessionRequestAttributionService,
  ScopeActivation.OnDemand,
  'requestAttribution',
);
