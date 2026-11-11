/**
 * Events emitted by the loop: prompt acknowledgements, turn and step lifecycle, appended messages, LLM
 * run events, tool events, hook events, and context and profile settlements.
 */
import type { ContentPart, ToolCall, ToolDescription } from '#/llm/message';
import type { LlmRunEvent, LlmTiming } from '#/llm/response';
import type { HistoryMessage, UserEntry } from '#/history/history';
import type { ToolHookPoint, ToolUpdate } from '#/tool/executor';
import type { HookLifecycleEvent, HookPoint } from './hook';
import type { MessageSource, RemindEntry, TurnTrigger } from './inbox';
import type { AsyncToolOutcome, Cause, StepOutcome, ToolCallOutcome, TurnOutcome } from './outcome';

export interface ToolStartDisplay {
  readonly kind: string;
}

export interface LlmMessageTiming {
  readonly llmFirstTokenLatencyMs?: number;
  readonly llmStreamDurationMs?: number;
}

export function llmMessageTiming(timing: LlmTiming | undefined): LlmMessageTiming | undefined {
  if (timing === undefined) return undefined;
  return {
    llmFirstTokenLatencyMs: timing.firstTokenLatencyMs,
    llmStreamDurationMs: timing.streamDurationMs,
  };
}

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
  | { type: 'tool.async_ended'; taskId?: string; toolCallId: string; outcome: AsyncToolOutcome; entry: UserEntry };

export type HookFailedEvent = {
  type: 'hook.failed';
  point: HookPoint | ToolHookPoint;
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
  | { type: 'prompt.steered'; promptIds: string[]; entries?: readonly UserEntry[] }
  | { type: 'prompt.canceled'; promptId: string; canceled: boolean }
  | { type: 'turn.started'; turnId: number; trigger: TurnTrigger; promptOnly?: true; entry?: UserEntry }
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
  | {
      type: 'step.ended';
      turnId: number;
      step: number;
      outcome: StepOutcome;
      timing?: LlmTiming;
      llmTiming?: LlmMessageTiming;
    }
  | { type: 'turn.ended'; turnId: number; outcome: TurnOutcome; durationMs?: number; stopReason?: string; requestId?: string }
  | { type: 'context.settled'; messages: HistoryMessage[]; reason?: string }
  | { type: 'context.rejected'; messages: HistoryMessage[]; reason?: string }
  | { type: 'system_prompt.settled'; systemPrompt: string }
  | { type: 'tools.settled'; tools: ToolDescription[] };

export type LoopAck<T extends LoopEmitted['type']> = Extract<LoopEmitted, { type: T }>;
