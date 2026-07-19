import { createDecorator } from '#/_base/di/instantiation';
import type { FinishReason, ThinkingEffort } from '#/kosong/contract/provider';
import type { Message, StreamedMessagePart } from '#/kosong/contract/message';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
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
  /** Trace id of the request that produced this finish (Kimi `x-trace-id`). */
  traceId?: string;
}

export type LLMRequestPartHandler = (part: StreamedMessagePart) => void | Promise<void>;

export interface LLMRequestOverrides {
  messages?: readonly Message[];
  tools?: readonly Tool[];
  systemPrompt?: string;
  source?: LLMRequestSource;
  maxOutputSize?: number;
}

export interface LLMRequestTask {
  readonly trace: LLMRequestTrace;
  readonly result: Promise<LLMRequestFinish>;
}

export interface PreparedTurnRequestConfig {
  readonly thinkingEffort: ThinkingEffort;
}

export interface IAgentLLMRequesterService {
  readonly _serviceBrand: undefined;

  prepareTurnConfig(turnId: number): PreparedTurnRequestConfig | undefined;

  request(
    overrides?: LLMRequestOverrides,
    onPart?: LLMRequestPartHandler,
    signal?: AbortSignal,
  ): Promise<LLMRequestFinish>;

  start(
    overrides?: LLMRequestOverrides,
    onPart?: LLMRequestPartHandler,
    signal?: AbortSignal,
  ): LLMRequestTask;
}

export const IAgentLLMRequesterService = createDecorator<IAgentLLMRequesterService>(
  'agentLLMRequesterService',
);
