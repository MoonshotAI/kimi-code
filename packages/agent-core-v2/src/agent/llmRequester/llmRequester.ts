import { createDecorator } from '#/_base/di/instantiation';
import type { FinishReason } from '#/app/llmProtocol/finishReason';
import type { Message, StreamedMessagePart } from '#/app/llmProtocol/message';
import type { Tool } from '#/app/llmProtocol/tool';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import type { LogContext } from '#/_base/log/log';

export type LLMRequestLogFields = Readonly<LogContext>;

export type LLMRequestSource =
  | {
      readonly type: 'turn';
      readonly turnId: number;
      readonly step?: number;
      readonly logFields?: LLMRequestLogFields;
    }
  | {
      readonly type: 'operation';
      readonly requestKind?: string;
      readonly logFields?: LLMRequestLogFields;
    };

export interface LLMStreamTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  readonly requestBuildMs?: number;
  readonly serverFirstTokenMs?: number;
  readonly serverDecodeMs?: number;
  readonly clientConsumeMs?: number;
}

export interface LLMRequestParams {
  messages: Message[];
  tools: readonly Tool[];
  signal: AbortSignal;
  source?: LLMRequestSource;
}

export interface LLMRequestFinish {
  message: Message;
  usage: TokenUsage;
  model?: string | undefined;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  providerMessageId?: string;
  timing?: LLMStreamTiming;
}

export type LLMRequestPartHandler = (part: StreamedMessagePart) => void | Promise<void>;

export interface LLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  source?: LLMRequestSource;
  maxOutputSize?: number;
}

export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;

  request(
    overrides?: LLMRequestOverrides,
    onPart?: LLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<LLMRequestFinish>;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>(
  'agentLLMRequesterService',
);
