/**
 * `loop` domain — the `turn.*` / delta event payloads published through
 * `IEventBus` as a turn runs. These are the loop's share of the agent event
 * stream; consumers (transports, replay, telemetry) subscribe by `type`.
 */

import type { KimiErrorPayload } from '#/_base/errors/serialize';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { FinishReason } from '#/app/llmProtocol/finishReason';
import type { TokenUsage } from '#/app/llmProtocol/usage';

/** Why a turn ended. `blocked` folds into `failed` at the wire edge. */
export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export interface TurnStartedEvent {
  readonly type: 'turn.started';
  readonly turnId: number;
  readonly origin: PromptOrigin;
}

export interface TurnEndedEvent {
  readonly type: 'turn.ended';
  readonly turnId: number;
  readonly reason: TurnEndReason;
  readonly error?: KimiErrorPayload;
  readonly durationMs?: number;
}

export interface TurnStepStartedEvent {
  readonly type: 'turn.step.started';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
}

export interface TurnStepCompletedEvent {
  readonly type: 'turn.step.completed';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly usage?: TokenUsage;
  readonly finishReason?: string;
  readonly llmFirstTokenLatencyMs?: number;
  readonly llmStreamDurationMs?: number;
  /**
   * Split of `llmFirstTokenLatencyMs`: in-process request-building time on the
   * client vs. network + API-server time to the first token. Both omitted when
   * the provider does not report the client/server boundary.
   */
  readonly llmRequestBuildMs?: number;
  readonly llmServerFirstTokenMs?: number;
  /**
   * Split of `llmStreamDurationMs` (the decode window): time awaiting parts from
   * the provider vs. time processing parts in-process. Both omitted when the
   * provider stream did not report decode accounting.
   */
  readonly llmServerDecodeMs?: number;
  readonly llmClientConsumeMs?: number;
  readonly providerFinishReason?: FinishReason;
  readonly rawFinishReason?: string;
}

export interface TurnStepInterruptedEvent {
  readonly type: 'turn.step.interrupted';
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly reason: string;
  readonly message?: string;
}

export interface AssistantDeltaEvent {
  readonly type: 'assistant.delta';
  readonly turnId: number;
  readonly delta: string;
}

export interface ThinkingDeltaEvent {
  readonly type: 'thinking.delta';
  readonly turnId: number;
  readonly delta: string;
}

export interface ToolCallDeltaEvent {
  readonly type: 'tool.call.delta';
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name?: string;
  readonly argumentsPart?: string;
}

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.started': TurnStartedEvent;
    'turn.ended': TurnEndedEvent;
    'turn.step.started': TurnStepStartedEvent;
    'turn.step.completed': TurnStepCompletedEvent;
    'turn.step.interrupted': TurnStepInterruptedEvent;
    'assistant.delta': AssistantDeltaEvent;
    'thinking.delta': ThinkingDeltaEvent;
    'tool.call.delta': ToolCallDeltaEvent;
  }
}
