import type { LlmErrorMessage } from '#/llm/errors';
import type { FinishInfo } from '#/llm/finish-reason';
import type { AssistantMessage, StreamedMessagePart, ToolCall } from '#/llm/message';
import type { TokenUsage } from '#/llm/usage';

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

export type LlmOutcome =
  | ({ readonly type: 'done' } & LlmOutput)
  | ({ readonly type: 'failed'; readonly error: LlmErrorMessage; readonly rawError?: unknown } & Partial<LlmOutput>)
  | ({ readonly type: 'aborted'; readonly message: AssistantMessage | null; readonly reason?: unknown } & Omit<LlmOutput, 'message'>);

export type LlmRunEvent = LlmStreamEvent | LlmSentEvent | LlmRetrying;
