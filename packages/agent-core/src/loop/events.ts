import type { FinishReason, TextPart, ThinkPart, TokenUsage } from '@moonshot-ai/kosong';

import type { ToolInputDisplay } from '../tools/display';
import type { ExecutableToolResult, LoopStepStopReason, ToolUpdate } from './types';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export interface LoopStepBeginEvent {
  readonly type: 'step.begin';
  readonly uuid: string;
  readonly turnId: string;
  readonly step: number;
}

export interface LoopStepEndEvent {
  readonly type: 'step.end';
  readonly uuid: string;
  readonly turnId: string;
  readonly step: number;
  readonly usage?: TokenUsage | undefined;
  readonly finishReason?: LoopStepStopReason | undefined;
  readonly llmFirstTokenLatencyMs?: number | undefined;
  readonly llmStreamDurationMs?: number | undefined;
  /**
   * Split of `llmFirstTokenLatencyMs`: in-process request-building time on the
   * client vs. network + API-server time to the first token. Both `undefined`
   * when the provider does not report the client/server boundary.
   */
  readonly llmRequestBuildMs?: number | undefined;
  readonly llmServerFirstTokenMs?: number | undefined;
  /**
   * Split of `llmStreamDurationMs` (the decode window): time awaiting parts
   * from the provider vs. time processing parts in-process. Both `undefined`
   * when the provider stream did not report decode accounting.
   */
  readonly llmServerDecodeMs?: number | undefined;
  readonly llmClientConsumeMs?: number | undefined;
  /**
   * Provider diagnostics are optional and must not drive loop control.
   * Use `finishReason` for normalized behavior.
   */
  readonly providerFinishReason?: FinishReason | undefined;
  readonly rawFinishReason?: string | undefined;
}

export interface LoopStepRetryingEvent {
  readonly type: 'step.retrying';
  readonly turnId: string;
  readonly step: number;
  readonly stepUuid: string;
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export interface LoopContentPartEvent {
  readonly type: 'content.part';
  readonly uuid: string;
  readonly turnId: string;
  readonly step: number;
  readonly stepUuid: string;
  readonly part: TextPart | ThinkPart;
}

export interface LoopToolCallEvent {
  readonly type: 'tool.call';
  readonly uuid: string;
  readonly turnId: string;
  readonly step: number;
  readonly stepUuid: string;
  readonly toolCallId: string;
  readonly name: string;
  readonly args: unknown;
  readonly description?: string | undefined;
  readonly display?: ToolInputDisplay | undefined;
}

export interface LoopToolResultEvent {
  readonly type: 'tool.result';
  readonly parentUuid: string;
  readonly toolCallId: string;
  readonly result: ExecutableToolResult;
}

export interface LoopTurnInterruptedEvent {
  readonly type: 'turn.interrupted';
  readonly reason: LoopInterruptReason;
  readonly attemptedSteps: number;
  readonly activeStep?: number | undefined;
  readonly message?: string | undefined;
}

export interface LoopTextDeltaEvent {
  readonly type: 'text.delta';
  readonly delta: string;
}

export interface LoopThinkingDeltaEvent {
  readonly type: 'thinking.delta';
  readonly delta: string;
}

export interface LoopToolCallDeltaEvent {
  readonly type: 'tool.call.delta';
  readonly toolCallId: string;
  readonly name?: string | undefined;
  readonly argumentsPart?: string | undefined;
}

export interface LoopToolProgressEvent {
  readonly type: 'tool.progress';
  readonly toolCallId: string;
  readonly update: ToolUpdate;
}

export type LoopRecordedEvent =
  | LoopStepBeginEvent
  | LoopStepEndEvent
  | LoopContentPartEvent
  | LoopToolCallEvent
  | LoopToolResultEvent;

export type LoopLiveOnlyEvent =
  | LoopTurnInterruptedEvent
  | LoopStepRetryingEvent
  | LoopTextDeltaEvent
  | LoopThinkingDeltaEvent
  | LoopToolCallDeltaEvent
  | LoopToolProgressEvent;

export type LoopEvent = LoopRecordedEvent | LoopLiveOnlyEvent;
export type LoopLiveEventEmitter = (event: LoopEvent) => void;

export type LoopEventDispatcher = {
  (event: LoopRecordedEvent): Promise<void>;
  (event: LoopLiveOnlyEvent): void;
};

export interface CreateLoopEventDispatcherInput {
  readonly appendTranscriptRecord: (record: LoopRecordedEvent) => Promise<void>;
  readonly emitLiveEvent?: LoopLiveEventEmitter | undefined;
}

export function createLoopEventDispatcher(
  input: CreateLoopEventDispatcherInput,
): LoopEventDispatcher {
  function dispatchEvent(event: LoopRecordedEvent): Promise<void>;
  function dispatchEvent(event: LoopLiveOnlyEvent): void;
  function dispatchEvent(event: LoopEvent): Promise<void> | void {
    if (isRecordedEvent(event)) {
      return recordEvent(input, event);
    }
    safeEmitLive(input.emitLiveEvent, event);
  }
  return dispatchEvent;
}

function isRecordedEvent(event: LoopEvent): event is LoopRecordedEvent {
  return (
    event.type === 'step.begin' ||
    event.type === 'step.end' ||
    event.type === 'content.part' ||
    event.type === 'tool.call' ||
    event.type === 'tool.result'
  );
}

async function recordEvent(
  input: CreateLoopEventDispatcherInput,
  event: LoopRecordedEvent,
): Promise<void> {
  await input.appendTranscriptRecord(event);
  safeEmitLive(input.emitLiveEvent, event);
}

function safeEmitLive(emit: LoopLiveEventEmitter | undefined, event: LoopEvent): void {
  if (emit === undefined) return;
  let maybePromise: unknown;
  try {
    maybePromise = (emit as (event: LoopEvent) => unknown)(event);
  } catch {
    return;
  }
  if (
    maybePromise !== undefined &&
    maybePromise !== null &&
    typeof (maybePromise as { then?: unknown }).then === 'function' &&
    typeof (maybePromise as { catch?: unknown }).catch === 'function'
  ) {
    (maybePromise as Promise<unknown>).catch(() => {
      // Live listeners are best-effort; their failures must not affect the turn.
    });
  }
}
