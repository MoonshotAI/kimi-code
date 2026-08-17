/**
 * `loop` domain — the `turn.*` / delta event payloads published through
 * `IEventBus` as a turn runs. These are the loop's share of the agent event
 * stream; consumers subscribe by `type`.
 * `turn.started` additionally carries the text extracted from the turn's
 * input parts (absent when the turn opened with no text part): consumers
 * that render the user's prompt must take it from there, because the context
 * append carrying the same text is not a bus event and lands later. The
 * prompt rides the event only for displayable user origins
 * ({@link isDisplayablePromptOrigin}) — a system-triggered turn (goal
 * continuation, subagent run, cron…) has internal steering text as its input,
 * which must never surface in transcripts. An upload's daemon-ref media part
 * is self-contained (`daemonFileRefFromPart`): its kind comes from the part
 * type and its file id from the reference, so the projection needs no
 * tag+ref pairing — the referenced media rides as
 * {@link TurnStartedEvent.promptAttachments}. When the turn's prompt bundles
 * skill activations, their rendered blocks (prepended to the content, one
 * text part per skill) are excluded from the extracted text.
 * `turn.started` also echoes the prompt record id as
 * {@link TurnStartedEvent.promptId} when the turn was opened by a prompt
 * submission, so submitters can bind their own bookkeeping (e.g. staged
 * uploads) to the exact turn that consumed them; turns opened any other way
 * (retry, goal continuation, …) leave it absent.
 */

import type { KimiErrorPayload } from '#/_base/errors/serialize';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { FinishReason } from '#/kosong/contract/provider';
import type { ContentPart, TextPart } from '#/kosong/contract/message';
import { daemonFileRefFromPart } from '#/agent/media/mediaRef';
import type { TokenUsage } from '#/kosong/contract/usage';

export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export type TurnInterruptReason =
  | 'user_cancelled'
  | 'aborted'
  | 'max_steps'
  | 'error'
  | 'filtered'
  | 'blocked';

/**
 * One daemon-referenced upload carried by the turn-opening input.
 */
export interface TurnPromptAttachment {
  readonly kind: 'image' | 'video';
  readonly fileId: string;
}

export interface TurnStartedEvent {
  readonly type: 'turn.started';
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly prompt?: string;
  readonly promptAttachments?: readonly TurnPromptAttachment[];
  readonly promptId?: string;
}

/**
 * The displayable projection of the turn-opening input: the prompt text,
 * plus one entry per daemon-referenced upload.
 */
export interface TurnPromptProjection {
  readonly text?: string;
  readonly attachments?: readonly TurnPromptAttachment[];
}

export function projectTurnPrompt(
  input: readonly ContentPart[],
  origin?: PromptOrigin,
): TurnPromptProjection {
  const bundledBlocks = origin?.kind === 'user' ? (origin.skillActivations?.length ?? 0) : 0;
  const text = input
    .filter((part): part is TextPart => part.type === 'text')
    .slice(bundledBlocks)
    .map((part) => part.text)
    .join('');
  const media = input.flatMap((part) => {
    const daemonPart = daemonFileRefFromPart(part);
    return daemonPart === undefined ? [] : [daemonPart];
  });
  return {
    text: text.length > 0 ? text : undefined,
    attachments:
      media.length === 0
        ? undefined
        : media.map((entry) => ({
            kind: entry.kind,
            fileId: entry.ref.fileId,
          })),
  };
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
  readonly interruptReason?: TurnInterruptReason;
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
  readonly llmRequestBuildMs?: number;
  readonly llmServerFirstTokenMs?: number;
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
