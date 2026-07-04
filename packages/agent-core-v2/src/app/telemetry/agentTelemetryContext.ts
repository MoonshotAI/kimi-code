/**
 * `telemetry` domain (L1) — `IAgentTelemetryContextService` contract.
 *
 * Agent-scoped ambient telemetry context: a per-agent property bag that domains
 * contribute to (for example the current `mode`) and that turn-scoped telemetry
 * snapshots at launch. Decouples turn telemetry from any specific mode owner so
 * the turn domain does not need to know about plan or other modes. Bound at
 * Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';
import type { TelemetryProperties } from './telemetry';

export interface IAgentTelemetryContextService {
  readonly _serviceBrand: undefined;

  /** Current ambient telemetry properties for this agent. */
  get(): TelemetryProperties;
  /** Merge a patch into the ambient telemetry context. */
  set(patch: TelemetryProperties): void;
}

export const IAgentTelemetryContextService = createDecorator<IAgentTelemetryContextService>(
  'agentTelemetryContextService',
);
