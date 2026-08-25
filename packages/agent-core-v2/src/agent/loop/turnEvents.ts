/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { parseDaemonFileUrl } from '#/agent/media/mediaRef';
import { AgentEvent2 } from '#/app/event/event2';
import type { FinishReason } from '#/kosong/contract/provider';
import type { ContentPart, TextPart } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';

export type TurnEndReason = 'completed' | 'cancelled' | 'failed' | 'blocked';

export type TurnInterruptReason =
  | 'user_cancelled'
  | 'aborted'
  | 'max_steps'
  | 'error'
  | 'filtered'
  | 'blocked';

export interface TurnStartedPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly origin: PromptOrigin;
  readonly prompt?: string;
  readonly promptAttachments?: readonly { kind: 'image' | 'video' | 'audio'; fileId: string }[];
}

export class TurnStarted extends AgentEvent2<TurnStartedPayload> {
  static override readonly type = 'turn.started';
  static override readonly observable = true;
}
export interface TurnStarted extends TurnStartedPayload {}

export function turnPromptText(
  input: readonly ContentPart[],
  origin?: PromptOrigin,
): string | undefined {
  const bundledBlocks = origin?.kind === 'user' ? (origin.skillActivations?.length ?? 0) : 0;
  const text = input
    .filter((part): part is TextPart => part.type === 'text')
    .slice(bundledBlocks)
    .map((part) => part.text)
    .join('');
  return text.length > 0 ? text : undefined;
}

export function turnPromptAttachments(
  input: readonly ContentPart[],
): TurnStartedPayload['promptAttachments'] {
  const attachments: { kind: 'image' | 'video' | 'audio'; fileId: string }[] = [];
  const sessionMediaFileId = (url: string, id: string | undefined): string | undefined => {
    if (id === undefined) return undefined;
    return parseDaemonFileUrl(url)?.fileId === id ? id : undefined;
  };
  for (const part of input) {
    if (part.type === 'image_url') {
      const fileId = sessionMediaFileId(part.imageUrl.url, part.imageUrl.id);
      if (fileId !== undefined) attachments.push({ kind: 'image', fileId });
    } else if (part.type === 'video_url') {
      const fileId = sessionMediaFileId(part.videoUrl.url, part.videoUrl.id);
      if (fileId !== undefined) attachments.push({ kind: 'video', fileId });
    } else if (part.type === 'audio_url') {
      const fileId = sessionMediaFileId(part.audioUrl.url, part.audioUrl.id);
      if (fileId !== undefined) attachments.push({ kind: 'audio', fileId });
    }
  }
  return attachments.length > 0 ? attachments : undefined;
}

export function isDisplayablePromptOrigin(origin: PromptOrigin): boolean {
  if (origin.kind === 'user') return true;
  return (
    (origin.kind === 'skill_activation' || origin.kind === 'plugin_command') &&
    origin.trigger === 'user-slash'
  );
}

export interface TurnStepStartedPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
}

export class TurnStepStarted extends AgentEvent2<TurnStepStartedPayload> {
  static override readonly type = 'turn.step.started';
  static override readonly observable = true;
}
export interface TurnStepStarted extends TurnStepStartedPayload {}

export interface TurnStepCompletedPayload {
  readonly agentId: string;
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

export class TurnStepCompleted extends AgentEvent2<TurnStepCompletedPayload> {
  static override readonly type = 'turn.step.completed';
  static override readonly observable = true;
}
export interface TurnStepCompleted extends TurnStepCompletedPayload {}

export interface TurnStepInterruptedPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly reason: string;
  readonly message?: string;
}

export class TurnStepInterrupted extends AgentEvent2<TurnStepInterruptedPayload> {
  static override readonly type = 'turn.step.interrupted';
  static override readonly observable = true;
}
export interface TurnStepInterrupted extends TurnStepInterruptedPayload {}

export interface AssistantDeltaPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly delta: string;
}

export class AssistantDelta extends AgentEvent2<AssistantDeltaPayload> {
  static override readonly type = 'assistant.delta';
  static override readonly observable = true;
}
export interface AssistantDelta extends AssistantDeltaPayload {}

export interface ThinkingDeltaPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly delta: string;
}

export class ThinkingDelta extends AgentEvent2<ThinkingDeltaPayload> {
  static override readonly type = 'thinking.delta';
  static override readonly observable = true;
}
export interface ThinkingDelta extends ThinkingDeltaPayload {}

export interface ToolCallDeltaPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly toolCallId: string;
  readonly name?: string;
  readonly argumentsPart?: string;
}

export class ToolCallDelta extends AgentEvent2<ToolCallDeltaPayload> {
  static override readonly type = 'tool.call.delta';
  static override readonly observable = true;
}
export interface ToolCallDelta extends ToolCallDeltaPayload {}
