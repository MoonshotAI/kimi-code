/**
 * `telemetry` domain (L1) — `IAgentTelemetryContextService` contract.
 *
 * Agent-scoped ambient telemetry context: a per-agent property bag that domains
 * contribute to (the `plan` domain sets `mode`, the `profile` domain mirrors
 * the resolved model protocol into `provider_type` / `protocol`, the `loop`
 * domain sets `turn_id` at turn start, and the `llmRequester` domain keeps
 * `trace_id` at the most recent request's `x-trace-id`) and that turn-scoped
 * telemetry snapshots at launch. Decouples turn telemetry from any
 * specific contributor so the turn domain does not need to know about plan or
 * profile. Bound at Agent scope.
 */

import { createDecorator } from '#/_base/di/instantiation';

export type AgentTelemetryContext = {
  mode: 'agent' | 'plan';
  provider_type?: string;
  protocol?: string;
  /** Active turn id, set by the loop at turn start. */
  turn_id?: number;
  /**
   * Trace id of the most recent LLM request in this agent (Kimi `x-trace-id`
   * response header); cleared at turn start and on requests without one.
   */
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
