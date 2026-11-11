/**
 * Request results: finish reasons, the `LlmErrorMessage` union, timing, notices, stream and retry
 * events, the `LlmRunEvent` vocabulary, and the final `LlmOutcome`.
 */
import type { AssistantEntry, FinishInfo, FinishReason } from '#/llm/history';
import type { StreamedMessagePart, ToolCall } from '#/llm/message';
import type { ThinkingEffort } from '#/llm/request';
import type { TokenUsage } from '#/llm/usage';

export type { FinishInfo, FinishReason } from '#/llm/history';
export type { TokenUsage };

export const NO_FINISH: FinishInfo = { finishReason: null, rawFinishReason: null };

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
  readonly statusCode?: number;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;
  readonly headers: Record<string, string> | null;
  readonly retryable: boolean;
  readonly code?: string;
  readonly name?: string;
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
            readonly retryable: boolean;
          }
        : {
            readonly kind: T;
            readonly message: string;
            readonly retryable: boolean;
            readonly code?: string;
            readonly name?: string;
          };

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

export function llmErrorName(error: LlmErrorMessage): string {
  const name = 'name' in error ? error.name : undefined;
  if (typeof name === 'string') return name;
  switch (error.kind) {
    case 'abort':
      return 'AbortError';
    case 'connection':
      return 'APIConnectionError';
    case 'timeout':
      return 'APITimeoutError';
    case 'empty_response':
      return 'APIEmptyResponseError';
    case 'context_overflow':
      return 'APIContextOverflowError';
    case 'rate_limit':
      return 'APIProviderRateLimitError';
    case 'quota_exhausted':
      return 'APIProviderQuotaExhaustedError';
    case 'overloaded':
      return 'APIProviderOverloadedError';
    case 'status':
    case 'request_too_large':
    case 'request_structure':
    case 'image_format':
    case 'auth':
      return 'APIStatusError';
    default:
      return 'ChatProviderError';
  }
}

export function llmErrorRequestId(error: LlmErrorMessage): string | undefined {
  const status = llmStatusErrorMessage(error);
  if (status === null) return undefined;
  if (status.requestId !== null) return status.requestId;
  const traceId = Object.entries(status.headers ?? {}).find(([name]) => name.toLowerCase() === 'x-trace-id')?.[1];
  return traceId === undefined || traceId.length === 0 ? undefined : traceId;
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
  | { readonly type: 'llm.streaming.request_id'; readonly requestId: string }
  | ({ readonly type: 'llm.timing' } & LlmTiming)
  | { readonly type: 'llm.streaming.part'; readonly part: StreamedMessagePart; readonly block?: number }
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
      readonly entry?: AssistantEntry | null;
      readonly usage?: TokenUsage;
      readonly headers?: Record<string, string>;
      readonly finish?: FinishInfo;
      readonly messageId?: string;
      readonly requestId?: string;
      readonly timing?: LlmTiming;
      readonly failedAttempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
    }
  | {
      readonly type: 'llm.retrying';
      readonly reason: 'recovery';
      readonly error: LlmErrorMessage;
      readonly entry?: AssistantEntry | null;
      readonly usage?: TokenUsage;
      readonly headers?: Record<string, string>;
      readonly finish?: FinishInfo;
      readonly messageId?: string;
      readonly requestId?: string;
      readonly timing?: LlmTiming;
      readonly strategy: string;
      readonly action: string;
    };

export interface LlmOutput {
  readonly entry: AssistantEntry;
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
  | ({ readonly type: 'aborted'; readonly entry: AssistantEntry | null; readonly reason?: unknown } & Omit<LlmOutput, 'entry'>);

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
