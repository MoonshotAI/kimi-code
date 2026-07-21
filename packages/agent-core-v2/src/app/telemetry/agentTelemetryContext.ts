/**
 * `telemetry` domain (L1) — `IAgentTelemetryContextService` contract.
 *
 * Agent-scoped mutable request context: the `plan` domain sets `mode`, the
 * `profile` domain mirrors the resolved model protocol into `provider_type` /
 * `protocol`, and the `loop` domain sets `turn_id` and `trace_id`. Turn
 * telemetry snapshots it at launch; immutable Agent identity is owned by the
 * scoped `ITelemetryService` view instead. Bound at Agent scope.
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
