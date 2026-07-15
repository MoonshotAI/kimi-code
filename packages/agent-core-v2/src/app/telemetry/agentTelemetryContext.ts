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
   *
   * Ambient distribution assumes LLM requests are serialized within one
   * agent — true by default (turns are mutually exclusive and compaction
   * blocks the turn). Two supported paths break that assumption: after-step
   * (non-blocking) compaction when `loopControl.compactionTriggerRatio` is
   * set below the block ratio, and turns launched through inject paths
   * (cron/shell inject, task/externalHooks/continuation enqueue) while a
   * manual compaction is running. During such overlaps this value is
   * last-writer-wins, so events reading it may attribute to the concurrent
   * request; per-request channels (`api_error`'s requestTraceId,
   * `compaction_finished`'s attempt trace) are unaffected.
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
