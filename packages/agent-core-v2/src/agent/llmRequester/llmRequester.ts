import { createDecorator } from "#/_base/di";
import type { FinishReason, Message, StreamedMessagePart, TokenUsage, Tool } from '#/app/llmProtocol';
import type { LLMRequestLogFields } from '#/agent/loop';
import type { UsageRecordContext } from '#/agent/usage';

export interface LLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  requestLogFields?: LLMRequestLogFields;
  usageContext?: UsageRecordContext;
  maxOutputSize?: number;
}

export type LLMEvent =
  | { readonly type: 'part'; readonly part: StreamedMessagePart }
  | { readonly type: 'usage'; readonly usage: TokenUsage; readonly model?: string }
  | {
      readonly type: 'finish';
      readonly providerFinishReason?: FinishReason;
      readonly rawFinishReason?: string;
      /** Provider-assigned response/message id, when available. */
      readonly id?: string;
    }
  | {
      readonly type: 'timing';
      readonly firstTokenLatencyMs: number;
      readonly streamDurationMs: number;
      readonly requestBuildMs?: number;
      readonly serverFirstTokenMs?: number;
      readonly serverDecodeMs?: number;
      readonly clientConsumeMs?: number;
    };

export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;
  request(overrides?: LLMRequestOverrides, signal?: AbortSignal): AsyncIterable<LLMEvent>;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>('agentLLMRequesterService');
