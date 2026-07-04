import { createDecorator } from '#/_base/di';
import type {
  FinishReason,
  Message,
  StreamedMessagePart,
  TokenUsage,
  Tool,
} from '#/app/llmProtocol';
import type { LogContext } from '#/app/log';

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

export interface LLMRequestRetryContext {
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export type LLMRequestRetryHandler = (
  context: LLMRequestRetryContext,
) => void | Promise<void>;

export interface LLMRequestRetryOptions {
  readonly maxAttempts?: number;
  readonly onRetry?: LLMRequestRetryHandler;
}

export interface LLMStreamTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  /**
   * Portion of `firstTokenLatencyMs` spent in-process building the request
   * (message serialization, param assembly) before the provider dispatched the
   * network call. `undefined` when the provider does not report the
   * client/server boundary (no `onRequestSent`).
   */
  readonly requestBuildMs?: number;
  /**
   * Portion of `firstTokenLatencyMs` spent waiting on the network + API server
   * from request dispatch to the first streamed token. `undefined` when the
   * provider does not report the client/server boundary.
   */
  readonly serverFirstTokenMs?: number;
  /**
   * Split of `streamDurationMs` (the decode window): time spent awaiting parts
   * from the provider vs. time spent processing parts in-process. Both are
   * `undefined` when the provider stream did not report decode accounting.
   */
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
  /** Fully assembled assistant message for this provider step. */
  message: Message;
  usage: TokenUsage;
  /** Model name/alias used for usage accounting, when known by the requester. */
  model?: string | undefined;
  providerFinishReason?: FinishReason;
  rawFinishReason?: string;
  /** Provider-assigned response/message id, when available. */
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
  retry?: LLMRequestRetryOptions;
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
