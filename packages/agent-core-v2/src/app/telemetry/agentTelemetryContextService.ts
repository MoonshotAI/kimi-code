/**
 * `telemetry` domain (L1) — `IAgentTelemetryContextService` implementation.
 *
 * Holds the agent's ambient telemetry context (defaults to `mode: 'agent'`);
 * merged into turn telemetry through `ITelemetryService.withContext` at turn
 * launch. Owns no cross-domain collaborators. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import {
  IAgentTelemetryContextService,
  type AgentTelemetryContext,
} from './agentTelemetryContext';

export class AgentTelemetryContextService implements IAgentTelemetryContextService {
  declare readonly _serviceBrand: undefined;
  private context: AgentTelemetryContext;

  constructor(@IAgentScopeContext scopeContext: IAgentScopeContext) {
    this.context = { mode: 'agent', agent_id: scopeContext.agentId };
  }

  get(): AgentTelemetryContext {
    return this.context;
  }

  set(patch: Partial<AgentTelemetryContext>): void {
    this.context = { ...this.context, ...patch };
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentTelemetryContextService,
  AgentTelemetryContextService,
  InstantiationType.Delayed,
  'telemetry',
);
