import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import type {
  AssistantMessageAttributes,
  Message,
  MessageAttributes,
  ToolMessageAttributes,
  UserMessage,
  UserMessageAttributes,
} from '@moonshot-ai/core/llm/message';
import { emptyUsage } from '@moonshot-ai/core/llm/usage';

export const EMPTY_LOOP_PROMPT: UserMessage = { role: 'user', content: [] };

function compactAttributes<T extends object>(attributes: T): T | undefined {
  const entries = Object.entries(attributes).filter(([, value]) => value !== undefined);
  return entries.length === 0 ? undefined : (Object.fromEntries(entries) as T);
}

function historyEntryFromContextWithOptions(
  entry: ContextMessage,
  preserveToolNotes: boolean,
): Message {
  const base: MessageAttributes = {
    origin: entry.origin,
    partial: entry.partial === true ? true : undefined,
    llmTiming: entry.llmTiming,
    note: entry.note,
    durationMs: entry.durationMs,
  };
  switch (entry.role) {
    case 'system': {
      const attributes = compactAttributes(base);
      return {
        role: 'system',
        content: entry.content,
        ...(entry.tools === undefined ? {} : { tools: entry.tools }),
        ...(attributes === undefined ? {} : { attributes }),
      };
    }
    case 'user': {
      const attributes = compactAttributes<UserMessageAttributes>({
        ...base,
        promptId: entry.id,
      });
      return {
        role: 'user',
        content: entry.content,
        ...(attributes === undefined ? {} : { attributes }),
      };
    }
    case 'assistant': {
      const attributes = compactAttributes<AssistantMessageAttributes>({
        ...base,
        messageId: entry.providerMessageId,
        usage: entry.usage ?? (entry.partial === true ? undefined : emptyUsage()),
      });
      return {
        role: 'assistant',
        content: entry.content,
        toolCalls: entry.toolCalls,
        ...(attributes === undefined ? {} : { attributes }),
      };
    }
    case 'tool': {
      const attributes = compactAttributes<ToolMessageAttributes>({
        ...base,
        isError: entry.isError === true ? true : undefined,
      });
      let content = entry.content;
      if (preserveToolNotes && entry.note !== undefined && entry.note.length > 0) {
        const last = content.at(-1);
        const rendered = last?.type === 'text' &&
          (last.text === entry.note || last.text.endsWith(`\n${entry.note}`));
        if (!rendered) content = [...content, { type: 'text', text: entry.note }];
      }
      return {
        role: 'tool',
        content,
        toolCallId: entry.toolCallId,
        ...(attributes === undefined ? {} : { attributes }),
      };
    }
  }
}

export function historyEntryFromContext(entry: ContextMessage): Message {
  return historyEntryFromContextWithOptions(entry, false);
}

export function historyFromContext(messages: readonly ContextMessage[]): Message[] {
  return messages.map(historyEntryFromContext);
}

export function historyFromContextPreservingToolNotes(
  messages: readonly ContextMessage[],
): Message[] {
  return messages.map((entry) => historyEntryFromContextWithOptions(entry, true));
}

export function contextFromHistoryEntry(
  entry: Message,
  toolCallDisplays?: Record<string, ToolInputDisplay>,
): ContextMessage {
  const attributes = entry.attributes as {
    readonly promptId?: string;
    readonly origin?: ContextMessage['origin'];
    readonly messageId?: string;
    readonly usage?: ContextMessage['usage'];
    readonly isError?: true;
    readonly partial?: true;
    readonly llmTiming?: ContextMessage['llmTiming'];
    readonly note?: string;
    readonly durationMs?: number;
  } | undefined;
  const legacy = entry as ContextMessage;
  const displays = toolCallDisplays !== undefined && Object.keys(toolCallDisplays).length > 0
    ? toolCallDisplays
    : undefined;
  const note = attributes?.note ?? legacy.note;
  let content = entry.content;
  if (entry.role === 'tool' && note !== undefined && note.length > 0) {
    const last = content.at(-1);
    if (last?.type === 'text' && last.text === note) {
      content = content.slice(0, -1);
    } else if (last?.type === 'text' && last.text.endsWith(`\n${note}`)) {
      const text = last.text.slice(0, -(note.length + 1));
      content = text.length === 0 ? content.slice(0, -1) : [...content.slice(0, -1), { ...last, text }];
    }
  }
  const { attributes: _attributes, ...coreMessage } = entry;
  return Object.fromEntries(
    Object.entries({
      ...coreMessage,
      content,
      id: attributes?.promptId ?? legacy.id,
      origin: attributes?.origin ?? legacy.origin,
      providerMessageId: attributes?.messageId ?? legacy.providerMessageId,
      usage: attributes?.usage,
      isError: attributes?.isError ?? legacy.isError,
      partial: attributes?.partial ?? legacy.partial,
      llmTiming: attributes?.llmTiming ?? legacy.llmTiming,
      note,
      durationMs: attributes?.durationMs ?? legacy.durationMs,
      toolCallDisplays: displays,
    }).filter(([, value]) => value !== undefined),
  ) as ContextMessage;
}
