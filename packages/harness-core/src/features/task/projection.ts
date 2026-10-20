import type { ToolMeta, UserEntry } from '@moonshot-ai/agent-core/history/index';
import { extractText, type ToolCall } from '@moonshot-ai/agent-core/llm/message';
import type { AsyncToolOutcome, LoopRecord } from '@moonshot-ai/agent-core/loop/index';
import type { Projection } from '@moonshot-ai/agent-core/store/index';

import { describeToolArguments } from './format';

export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'lost';

export interface TaskRecord {
  readonly taskId: string;
  readonly toolName: string;
  readonly description?: string;
  readonly detachText?: string;
  readonly status: TaskStatus;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly stopReason?: string;
  readonly output?: string;
}

export type TaskState = ReadonlyMap<string, TaskRecord>;

export interface TaskFoldState {
  readonly records: TaskState;
  readonly calls: ReadonlyMap<string, ToolCall>;
}

export interface TaskSettlement {
  readonly status: TaskStatus;
  readonly stopReason?: string;
  readonly output?: string;
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function isLoopCause(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null) return false;
  const cause = reason as { by?: unknown; reason?: unknown };
  return typeof cause.by === 'string' && typeof cause.reason === 'string';
}

function outputText(entry: UserEntry): string {
  const texts = entry.message.content.filter((part) => part.type === 'text');
  return texts
    .slice(1)
    .map((part) => part.text)
    .join('');
}

function failureText(entry: UserEntry): string | undefined {
  const first = entry.message.content.find((part) => part.type === 'text');
  if (first === undefined || first.type !== 'text') return undefined;
  const index = first.text.indexOf('\n');
  return index < 0 ? undefined : first.text.slice(index + 1);
}

export function settleFromAsync(outcome: AsyncToolOutcome, entry: UserEntry): TaskSettlement {
  if (outcome.type === 'succeeded') return { status: 'completed', output: outputText(entry) };
  if (outcome.type === 'failed') {
    const message = errorMessage(outcome.error) ?? failureText(entry);
    return { status: 'failed', stopReason: message, output: message };
  }
  if (isLoopCause(outcome.reason)) return { status: 'lost' };
  const message = errorMessage(outcome.reason);
  return { status: 'killed', stopReason: message, output: message };
}

export const taskProjection: Projection<TaskFoldState, LoopRecord> = {
  initial: () => ({ records: new Map(), calls: new Map() }),
  reduce: (state, entry) => {
    const { event } = entry;
    if (event.type === 'tool.started') {
      if (state.calls.has(event.toolCall.id)) return state;
      return { ...state, calls: new Map([...state.calls, [event.toolCall.id, event.toolCall]]) };
    }
    if (event.type === 'message.appended') {
      const appended = event.entry;
      if (appended.message.role === 'assistant') {
        const fresh = appended.message.toolCalls.filter((call) => !state.calls.has(call.id));
        if (fresh.length === 0) return state;
        const calls = new Map(state.calls);
        for (const call of fresh) calls.set(call.id, call);
        return { ...state, calls };
      }
      if (appended.message.role !== 'tool') return state;
      if ((appended.meta as ToolMeta | undefined)?.detached !== true) return state;
      const taskId = appended.message.toolCallId;
      if (state.records.has(taskId)) return state;
      const call = state.calls.get(taskId);
      const record: TaskRecord = {
        taskId,
        toolName: call?.name ?? 'unknown',
        description: describeToolArguments(call?.arguments ?? null),
        detachText: extractText(appended.message),
        status: 'running',
        startedAt: entry.time,
      };
      return { ...state, records: new Map([...state.records, [taskId, record]]) };
    }
    if (event.type === 'tool.async_ended') {
      const record = state.records.get(event.toolCallId);
      if (record === undefined || record.status !== 'running') return state;
      return {
        ...state,
        records: new Map([
          ...state.records,
          [event.toolCallId, { ...record, ...settleFromAsync(event.outcome, event.entry), endedAt: entry.time }],
        ]),
      };
    }
    return state;
  },
};
