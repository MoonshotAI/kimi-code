import type { ContentPart, Message, ToolCall, ToolDescription, UserMessage } from '#/llm/message';
import type { LlmRunEvent, LlmTiming } from '#/llm/response';
import type { HookPoint } from './hook';
import type { MessageSource, RemindMessage, TurnTrigger } from './inbox';
import type { AsyncToolOutcome, Cause, StepOutcome, ToolCallOutcome, TurnOutcome } from './outcome';

export interface ToolStartDisplay {
  readonly kind: string;
}

export interface ToolUpdate {
  key: string;
  text: string;
  percent?: number;
}

export interface LlmMessageTiming {
  readonly llmFirstTokenLatencyMs?: number;
  readonly llmStreamDurationMs?: number;
}

export type TurnContinuation = 'turn' | 'background' | 'none';

export type ToolEvent =
  | { type: 'tool.started'; taskId?: string; turnId: number; step: number; toolCall: ToolCall; args?: unknown; display?: ToolStartDisplay }
  | { type: 'tool.delta'; toolCallId: string; update: ToolUpdate }
  | {
      type: 'tool.ended';
      taskId?: string;
      toolCallId: string;
      outcome: ToolCallOutcome;
      detached: boolean;
      result?: {
        output: string | readonly ContentPart[];
        isError?: boolean;
        note?: string;
        durationMs?: number;
        stopTurn?: boolean;
        stopTurnReason?: string;
      };
    }
  | { type: 'tool.async_ended'; taskId?: string; toolCallId: string; outcome: AsyncToolOutcome; message: UserMessage };

export type HookFailedEvent = {
  type: 'hook.failed';
  point: HookPoint;
  hookId?: string;
  turnId: number;
  step: number;
  error: unknown;
  paused: boolean;
};

export type LoopEmitted =
  /** A user message was accepted into the normal inbox (`Loop.submit`). */
  | { type: 'prompt.submitted'; message: UserMessage }
  /** A user message entered the notify inbox (`Loop.notify`, `Loop.recordNotification`, `Loop.sendNow`), or a notification was synthesized (hook failure, detached tool completion). */
  | { type: 'prompt.notified'; message: UserMessage }
  /** A message was queued in the remind inbox (`Loop.remind`). */
  | { type: 'prompt.reminded'; message: RemindMessage }
  /** Messages moved from the normal inbox to the notify inbox (`Loop.steer`, `Loop.sendNowQueued`); `messages` lists the moved ones, absent when nothing moved. */
  | { type: 'prompt.steered'; promptIds: string[]; messages?: readonly UserMessage[] }
  /** A queued message was removed from the inboxes (`Loop.cancel`); `canceled` is false when nothing matched. */
  | { type: 'prompt.canceled'; promptId: string; canceled: boolean; startingTurnId?: number }
  | { type: 'turn.started'; turnId: number; trigger: TurnTrigger; promptOnly?: true; message?: UserMessage }
  | { type: 'turn.resumed'; turnId: number; step: number }
  | {
      type: 'message.appended';
      turnId: number;
      step: number;
      source: MessageSource;
      message: Message;
      blocked?: Cause;
    }
  | { type: 'step.started'; turnId: number; step: number }
  | LlmRunEvent
  | ToolEvent
  | HookFailedEvent
  | {
      type: 'step.ended';
      turnId: number;
      step: number;
      outcome: StepOutcome;
      timing?: LlmTiming;
      llmTiming?: LlmMessageTiming;
    }
  | { type: 'turn.ended'; turnId: number; outcome: TurnOutcome; durationMs?: number; stopReason?: string; requestId?: string; continuation?: TurnContinuation }
  | { type: 'context.settled'; messages: Message[]; reason?: string }
  | { type: 'context.rejected'; messages: Message[]; reason?: string }
  | { type: 'system_prompt.settled'; systemPrompt: string }
  | { type: 'tools.settled'; tools: ToolDescription[] };

export type LoopAck<T extends LoopEmitted['type']> = Extract<LoopEmitted, { type: T }>;
