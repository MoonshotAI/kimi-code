/**
 * `telemetry` domain — `IAgentTelemetryContextService` contract.
 *
 * Agent-scoped mutable request context holding `mode`, `provider_type` /
 * `protocol`, `turn_id`, and `trace_id`, snapshotted by turn telemetry at
 * launch. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export type AgentTelemetryContext = {
  mode: 'agent' | 'plan';
  provider_type?: string;
  protocol?: string;
  turn_id?: number;
  trace_id?: string;
};

export interface IAgentTelemetryContextService {
  readonly _serviceBrand: undefined;

  get(): AgentTelemetryContext;
  set(patch: Partial<AgentTelemetryContext>): void;
}

export const IAgentTelemetryContextService = createDecorator<IAgentTelemetryContextService>(
  'agentTelemetryContextService',
);
