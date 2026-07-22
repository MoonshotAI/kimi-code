/**
 * `loop` domain — the `turn.*` / delta event payloads published through
 * `IEventBus` as a turn runs. These are the loop's share of the agent event
 * stream; consumers (transports, replay, telemetry) subscribe by `type`.
 * `turn.started` additionally carries the text extracted from the turn's
 * input parts (absent when the turn opened with no text part): consumers
 * that render the user's prompt must take it from there, because the context
 * append carrying the same text is not a bus event and lands later. The
 * prompt rides the event only for displayable user origins
 * ({@link isDisplayablePromptOrigin}) — a system-triggered turn (goal
 * continuation, subagent run, cron…) has internal steering text as its input,
 * which must never surface in transcripts.
 */

import type { KimiErrorPayload } from '#/_base/errors/serialize';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { FinishReason } from '#/kosong/contract/provider';
import type { ContentPart, TextPart } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';

/** Why a turn ended. `blocked` folds into `failed` at the wire edge. */
export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export interface TurnStartedEvent {
  readonly type: 'turn.started';
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly prompt?: string;
}

export function turnPromptText(input: readonly ContentPart[]): string | undefined {
  const text = input
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
  return text.length > 0 ? text : undefined;
}

export function isDisplayablePromptOrigin(origin: PromptOrigin): boolean {
  if (origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
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
