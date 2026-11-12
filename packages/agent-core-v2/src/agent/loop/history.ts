import type { ContextMessage } from '#/agent/contextMemory/types';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import type { HistoryMessage } from '#human/agent/turn';
import type { UserMessage } from '#human/llm/message';
import { emptyUsage } from '#human/llm-requester/usage';

export const EMPTY_LOOP_PROMPT: UserMessage = { role: 'user', content: [] };

export function historyEntryFromContext(entry: ContextMessage, preserveToolNotes = false): HistoryMessage {
  const meta = {
    promptId: entry.id,
    origin: entry.origin,
    messageId: entry.providerMessageId,
    usage: entry.usage,
    isError: entry.isError === true ? true as const : undefined,
    partial: entry.partial === true ? true as const : undefined,
    llmTiming: entry.llmTiming,
    note: entry.note,
    durationMs: entry.durationMs,
  };
  const message = { ...entry };
  delete message.id;
  delete message.origin;
  delete message.providerMessageId;
  delete message.usage;
  delete message.isError;
  delete message.partial;
  delete message.llmTiming;
  delete message.note;
  delete message.durationMs;
  delete message.toolCallDisplays;
  switch (entry.role) {
    case 'system':
      return { message: { ...message, role: 'system' }, meta };
    case 'user':
      return { message: { ...message, role: 'user' }, meta };
    case 'assistant':
      return {
        message: { ...message, role: 'assistant', toolCalls: entry.toolCalls },
        meta: { ...meta, usage: entry.usage ?? (entry.partial === true ? undefined : emptyUsage()) },
      };
    case 'tool': {
      let content = entry.content;
      if (preserveToolNotes && entry.note !== undefined && entry.note.length > 0) {
        const last = content.at(-1);
        const rendered = last?.type === 'text' &&
          (last.text === entry.note || last.text.endsWith(`\n${entry.note}`));
        if (!rendered) content = [...content, { type: 'text', text: entry.note }];
      }
      return { message: { ...message, role: 'tool', content, toolCallId: entry.toolCallId }, meta };
    }
  }
}

export function historyFromContext(
  messages: readonly ContextMessage[],
  preserveToolNotes = false,
): HistoryMessage[] {
  return messages.map((entry) => historyEntryFromContext(entry, preserveToolNotes));
}

export function contextFromHistoryEntry(
  entry: HistoryMessage,
  toolCallDisplays?: Record<string, ToolInputDisplay>,
): ContextMessage {
  const meta = entry.meta as {
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
  const message = entry.message as ContextMessage;
  const displays = toolCallDisplays !== undefined && Object.keys(toolCallDisplays).length > 0
    ? toolCallDisplays
    : undefined;
  return Object.fromEntries(
    Object.entries({
      ...message,
      id: meta?.promptId ?? message.id,
      origin: meta?.origin ?? message.origin,
      providerMessageId: meta?.messageId ?? message.providerMessageId,
      usage: meta?.usage,
      isError: meta?.isError ?? message.isError,
      partial: meta?.partial ?? message.partial,
      llmTiming: meta?.llmTiming ?? message.llmTiming,
      note: meta?.note ?? message.note,
      durationMs: meta?.durationMs ?? message.durationMs,
      toolCallDisplays: displays,
    }).filter(([, value]) => value !== undefined),
  ) as ContextMessage;
}
