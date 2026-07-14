/**
 * `telemetry` domain (L1) — `IAgentTelemetryContextService` implementation.
 *
 * Holds the agent's ambient telemetry context (defaults to `mode: 'agent'`);
 * merged into turn telemetry through `ITelemetryService.withContext` at turn
 * launch. Owns no cross-domain collaborators. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  IAgentTelemetryContextService,
  type AgentTelemetryContext,
} from './agentTelemetryContext';

export class AgentTelemetryContextService implements IAgentTelemetryContextService {
  declare readonly _serviceBrand: undefined;
  private context: AgentTelemetryContext = { mode: 'agent' };

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
  InstantiationType.Eager,
  'telemetry',
);
