import type { FinishInfo } from '#/llm/response';
import type {
  AssistantMessage,
  ContentPart,
  Message,
  SystemMessage,
  ToolMessage,
  UserMessage,
} from '#/llm/message';
import type { TokenUsage } from '#/llm/usage';

import type { PromptOrigin } from './origin';

export interface EntryMeta {
  source?: string;
  key?: string;
  origin?: PromptOrigin;
  partial?: true;
  llmTiming?: {
    llmFirstTokenLatencyMs?: number;
    llmStreamDurationMs?: number;
  };
  note?: string;
  durationMs?: number;
}

export type SystemMeta = EntryMeta;

export interface UserMeta extends EntryMeta {
  promptId?: string;
  origin?: PromptOrigin;
  createdAt?: string;
  userMessageId?: string;
  toolCallId?: string;
  bypassMaxSteps?: boolean;
}

export interface ToolMeta extends EntryMeta {
  isError?: true;
  stopTurn?: true;
  detached?: true;
}

export interface AssistantMeta extends EntryMeta {
  model?: { provider: string; model: string };
  usage?: TokenUsage;
  headers?: Record<string, string>;
  finish?: FinishInfo;
  messageId?: string;
}

export interface HistoryEntry<T extends Message, F extends EntryMeta> {
  message: T;
  meta?: F;
}

export type SystemEntry = HistoryEntry<SystemMessage, SystemMeta>;

export type UserEntry = HistoryEntry<UserMessage, UserMeta>;

export type ToolEntry = HistoryEntry<ToolMessage, ToolMeta>;

export type AssistantEntry = HistoryEntry<AssistantMessage, AssistantMeta>;

export type HistoryMessage = SystemEntry | UserEntry | AssistantEntry | ToolEntry;

export function createUserEntry(message: UserMessage, meta: UserMeta = {}): UserEntry {
  return { message, meta };
}

export function createSystemEntry(message: SystemMessage, meta: SystemMeta = {}): SystemEntry {
  return { message, meta };
}

export function createToolEntry(message: ToolMessage, meta: ToolMeta = {}): ToolEntry {
  return { message, meta };
}

export function createAssistantEntry(
  message: AssistantMessage,
  meta: AssistantMeta,
): AssistantEntry {
  return { message, meta };
}

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS = '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

export interface RenderableToolResult {
  readonly output: string | readonly ContentPart[];
  readonly isError?: boolean;
}

export function renderToolResultForModel(result: RenderableToolResult): ContentPart[] {
  const output = result.output;
  const sourcePart = typeof output === 'string' ? undefined : output[0];
  const single =
    typeof output === 'string'
      ? output
      : output.length === 1 && sourcePart?.type === 'text'
        ? sourcePart.text
        : undefined;
  if (single !== undefined) {
    if (result.isError === true) {
      if (single.length === 0) return [{ type: 'text', text: TOOL_EMPTY_ERROR_STATUS }];
      return [{ type: 'text', text: TOOL_ERROR_STATUS + '\n' + single }];
    }
    const trimmed = single.trim();
    if (trimmed.length === 0 || trimmed === TOOL_OUTPUT_EMPTY_TEXT) {
      return [{ type: 'text', text: TOOL_EMPTY_STATUS }];
    }
    return [sourcePart ?? { type: 'text', text: single }];
  }
  const parts = output as readonly ContentPart[];
  if (parts.every((part) => part.type === 'text' && part.text.trim().length === 0)) {
    return [{ type: 'text', text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS }];
  }
  if (result.isError === true) return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...parts];
  return [...parts];
}

export function toRequestMessages(history: readonly HistoryMessage[]): Message[] {
  return history.map((entry) =>
    entry.message.role === 'tool'
      ? {
          ...entry.message,
          content: renderToolResultForModel({
            output: entry.message.content,
            isError: (entry.meta as ToolMeta | undefined)?.isError === true,
          }),
        }
      : entry.message,
  );
}
