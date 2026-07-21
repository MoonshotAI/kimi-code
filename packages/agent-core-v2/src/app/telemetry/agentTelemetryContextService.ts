/**
 * `telemetry` domain (L1) — `IAgentTelemetryContextService` implementation.
 *
 * Holds mutable request context (defaulting to `mode: 'agent'`) that turn
 * telemetry snapshots through `ITelemetryService.withContext` at launch.
 * Immutable Agent identity is owned by the scoped telemetry view. Bound at
 * Agent scope; has no cross-domain collaborators.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
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
  InstantiationType.Eager,
  'telemetry',
);
