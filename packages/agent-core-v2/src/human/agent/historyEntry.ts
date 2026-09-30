import type { FinishInfo } from '#/llm/finish-reason';
import type {
  AssistantMessage,
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
}

export type SystemMeta = EntryMeta;

export interface UserMeta extends EntryMeta {
  promptId?: string;
  origin?: PromptOrigin;
  tracked?: boolean;
  createdAt?: string;
  userMessageId?: string;
}

export type ToolMeta = EntryMeta;

export interface AssistantMeta extends EntryMeta {
  model?: { provider: string; model: string };
  usage: TokenUsage;
  headers?: Record<string, string>;
  finish?: FinishInfo;
  messageId?: string;
}

export type AssistantMetaInput = Omit<AssistantMeta, 'usage'> & { usage?: TokenUsage };

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
