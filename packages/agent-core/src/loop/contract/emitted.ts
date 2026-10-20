import type { ToolCall, ToolDescription } from '#/llm/message';
import type { LlmRunEvent } from '#/llm/response';
import type { HistoryMessage, UserEntry } from '#/history/message';
import type { ToolUpdate } from '#/tool/index';
import type { HookLifecycleEvent, HookPoint } from './hook';
import type { MessageSource, RemindEntry, TurnTrigger } from './inbox';
import type { AsyncToolOutcome, Cause, StepOutcome, ToolCallOutcome, TurnOutcome } from './outcome';

export type ToolEvent =
  | { type: 'tool.started'; turnId: number; step: number; toolCall: ToolCall }
  | { type: 'tool.delta'; toolCallId: string; update: ToolUpdate }
  | { type: 'tool.ended'; toolCallId: string; outcome: ToolCallOutcome; detached: boolean }
  | { type: 'tool.async_ended'; toolCallId: string; outcome: AsyncToolOutcome; entry: UserEntry };

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
  | { type: 'prompt.submitted'; entry: UserEntry }
  | { type: 'prompt.notified'; entry: UserEntry }
  | { type: 'prompt.reminded'; entry: RemindEntry }
  | { type: 'prompt.steered'; promptIds: string[]; entry?: UserEntry }
  | { type: 'prompt.canceled'; promptId: string; canceled: boolean }
  | { type: 'turn.started'; turnId: number; trigger: TurnTrigger }
  | { type: 'turn.resumed'; turnId: number; step: number }
  | {
      type: 'message.appended';
      turnId: number;
      step: number;
      source: MessageSource;
      entry: HistoryMessage;
      blocked?: Cause;
    }
  | { type: 'step.started'; turnId: number; step: number }
  | LlmRunEvent
  | ToolEvent
  | HookFailedEvent
  | HookLifecycleEvent
  | { type: 'step.ended'; turnId: number; step: number; outcome: StepOutcome }
  | { type: 'turn.ended'; turnId: number; outcome: TurnOutcome }
  | { type: 'context.settled'; messages: HistoryMessage[]; reason?: string }
  | { type: 'context.rejected'; messages: HistoryMessage[]; reason?: string }
  | { type: 'system_prompt.settled'; systemPrompt?: string }
  | { type: 'system_prompt.rejected'; systemPrompt?: string }
  | { type: 'tools.settled'; tools: ToolDescription[] }
  | { type: 'tools.rejected'; tools: ToolDescription[] };

export type LoopAck<T extends LoopEmitted['type']> = Extract<LoopEmitted, { type: T }>;
