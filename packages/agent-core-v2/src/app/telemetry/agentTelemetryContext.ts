/**
 * `telemetry` domain (L1) — `IAgentTelemetryContextService` contract.
 *
 * Agent-scoped ambient telemetry context: a per-agent property bag that domains
 * contribute to (the `plan` domain sets `mode`, the `profile` domain mirrors
 * the resolved model protocol into `provider_type` / `protocol`) and that
 * turn-scoped telemetry snapshots at launch. Decouples turn telemetry from any
 * specific contributor so the turn domain does not need to know about plan or
 * profile. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export type AgentTelemetryContext = {
  mode: 'agent' | 'plan';
  provider_type?: string;
  protocol?: string;
};

export interface IAgentTelemetryContextService {
  readonly _serviceBrand: undefined;

  get(): AgentTelemetryContext;
  set(patch: Partial<AgentTelemetryContext>): void;
}

export const IAgentTelemetryContextService = createDecorator<IAgentTelemetryContextService>(
  'agentTelemetryContextService',
);
