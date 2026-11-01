import type { AssistantMessage, StreamedMessagePart, ToolCall } from '#/llm/message';
import type { ThinkingEffort } from '#/llm/request';

export type FinishReason =
  | 'completed'                                                                                                     
  | 'tool_calls'                                                          
  | 'truncated'                                                                                                        
  | 'filtered'                                                                                                                                                                     
  | 'paused'                         
  | 'other';                                                                                                                                    

export interface FinishInfo {
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
}

export const NO_FINISH: FinishInfo = { finishReason: null, rawFinishReason: null };

export interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  raw?: Record<string, unknown>;
}

export type LlmErrorKind =
  | 'syntax'
  | 'abort'
  | 'connection'
  | 'timeout'
  | 'status'
  | 'auth'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'overloaded'
  | 'context_overflow'
  | 'request_too_large'
  | 'request_structure'
  | 'image_format'
  | 'empty_response'
  | 'provider'
  | 'unknown';

export type LlmRemoteErrorKind = Exclude<LlmErrorKind, 'syntax'>;

export type LlmSyntaxErrorCode = 'request_format' | 'thinking_config' | 'internal';

export type LlmStatusErrorKind =
  | 'status'
  | 'auth'
  | 'rate_limit'
  | 'quota_exhausted'
  | 'overloaded'
  | 'context_overflow'
  | 'request_too_large'
  | 'request_structure'
  | 'image_format';

export interface LlmStatusErrorInfo {
  readonly statusCode: number;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly headers: Record<string, string> | null;
}

export type LlmErrorMessage<T extends LlmErrorKind = LlmErrorKind> =
  T extends LlmStatusErrorKind
    ? { readonly kind: T; readonly message: string } & LlmStatusErrorInfo
    : T extends 'syntax'
      ? { readonly kind: T; readonly message: string; readonly code: LlmSyntaxErrorCode }
      : T extends 'empty_response'
        ? {
            readonly kind: T;
            readonly message: string;
            readonly finishReason: FinishReason | null;
            readonly rawFinishReason: string | null;
          }
        : { readonly kind: T; readonly message: string };

export type LlmRemoteErrorMessage = LlmErrorMessage<LlmRemoteErrorKind>;

export function llmStatusErrorMessage(
  error: LlmErrorMessage,
): LlmErrorMessage<LlmStatusErrorKind> | null {
  switch (error.kind) {
    case 'status':
    case 'auth':
    case 'rate_limit':
    case 'quota_exhausted':
    case 'overloaded':
    case 'context_overflow':
    case 'request_too_large':
    case 'request_structure':
    case 'image_format':
      return error;
    default:
      return null;
  }
}

export interface LlmTiming {
  readonly firstTokenLatencyMs: number;
  readonly streamDurationMs: number;
  readonly requestBuildMs?: number;
  readonly serverFirstTokenMs?: number;
  readonly serverDecodeMs: number;
  readonly clientConsumeMs: number;
  readonly clientBlockedMs?: number;
}

export interface LlmNoticeInput {
  readonly code: string;
  readonly message: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface LlmNotice extends LlmNoticeInput {
  readonly source: string;
}

export type LlmNoticeSink = (notice: LlmNoticeInput) => void;

export type LlmStreamEvent =
  | { readonly type: 'llm.notice'; readonly notice: LlmNotice }
  | { readonly type: 'llm.streaming.headers'; readonly headers: Record<string, string> }
  | { readonly type: 'llm.streaming.part'; readonly part: StreamedMessagePart }
  | { readonly type: 'llm.streaming.usage'; readonly usage: Partial<TokenUsage> }
  | { readonly type: 'llm.streaming.finish'; readonly finish: FinishInfo }
  | { readonly type: 'llm.streaming.tool_call_end'; readonly toolCall: ToolCall; readonly index?: number | string }
  | { readonly type: 'llm.streaming.message_id'; readonly messageId: string };

export type LlmSentEvent = { readonly type: 'llm.sent' };

export type LlmRetrying =
  | {
      readonly type: 'llm.retrying';
      readonly reason: 'backoff';
      readonly error: LlmErrorMessage;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
    }
  | {
      readonly type: 'llm.retrying';
      readonly reason: 'recovery';
      readonly error: LlmErrorMessage;
      readonly strategy: string;
      readonly action: string;
    };

export interface LlmOutput {
  readonly message: AssistantMessage;
  readonly usage?: TokenUsage;
  readonly headers?: Record<string, string>;
  readonly finish?: FinishInfo;
  readonly messageId?: string;
  readonly requestId?: string;
  readonly timing?: LlmTiming;
}

export type LlmErrorDiagnostics = Readonly<Record<string, unknown>>;

export type LlmOutcome =
  | ({ readonly type: 'done' } & LlmOutput)
  | ({
      readonly type: 'failed';
      readonly error: LlmErrorMessage;
      readonly rawError?: unknown;
      readonly diagnostics?: LlmErrorDiagnostics;
    } & Partial<LlmOutput>)
  | ({ readonly type: 'aborted'; readonly message: AssistantMessage | null; readonly reason?: unknown } & Omit<LlmOutput, 'message'>);

export interface LlmRequestSummary {
  readonly provider: string;
  readonly model: string;
  readonly thinkingEffort?: ThinkingEffort;
  readonly thinkingKeep?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number | 'none';
  readonly systemPromptHash?: string;
  readonly toolsHash?: string;
  readonly messageCount: number;
}

export type LlmRunStarted = { readonly type: 'llm.started' } & LlmRequestSummary;

export type LlmRunEvent =
  | LlmRunStarted
  | LlmSentEvent
  | LlmStreamEvent
  | LlmRetrying
  | { readonly type: 'llm.ended'; readonly outcome: LlmOutcome };
