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
  /** Current agent mode; owned by the `plan` domain. */
  mode: 'agent' | 'plan';
  /**
   * Resolved model protocol, mirrored to v1's `provider_type` — v2 has no
   * separate provider type, so both keys carry the protocol. Undefined when
   * the bound model is unresolvable. Owned by the `profile` domain.
   */
  provider_type?: string;
  /** Resolved model protocol; undefined when the bound model is unresolvable. */
  protocol?: string;
};

export interface IAgentTelemetryContextService {
  readonly _serviceBrand: undefined;

  /** Current ambient telemetry properties for this agent. */
  get(): AgentTelemetryContext;
  /** Merge a patch into the ambient telemetry context. */
  set(patch: Partial<AgentTelemetryContext>): void;
}

export const IAgentTelemetryContextService = createDecorator<IAgentTelemetryContextService>(
  'agentTelemetryContextService',
);
