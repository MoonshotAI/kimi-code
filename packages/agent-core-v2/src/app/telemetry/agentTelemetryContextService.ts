/**
 * `telemetry` domain — `IAgentTelemetryContextService` implementation.
 *
 * Holds mutable request context (defaulting to `mode: 'agent'`) that turn
 * telemetry snapshots at launch. Bound at Agent scope; has no cross-domain
 * collaborators.
 */

import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import {
  IAgentTelemetryContextService,
  type AgentTelemetryContext,
} from './agentTelemetryContext';

export class AgentTelemetryContextService implements IAgentTelemetryContextService {
  declare readonly _serviceBrand: undefined;
  private context: AgentTelemetryContext;

  constructor() {
    this.context = { mode: 'agent' };
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
  ScopeActivation.OnScopeCreated,
  'telemetry',
);
