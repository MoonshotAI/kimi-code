import type { HistoryMessage } from '#human/agent/turn';
import { isAssistantEntry } from '#human/agent/turn';
import type { UserMessage } from '#human/llm/message';
import { emptyUsage } from '#human/llm/usage';

export const EMPTY_MACHINE_PROMPT: UserMessage = { role: 'user', content: [] };

export function historyFromContext(messages: readonly HistoryMessage[]): HistoryMessage[] {
  return messages.map((entry) => {
    if (!isAssistantEntry(entry)) return entry;
    if (entry.meta?.usage !== undefined) return entry;
    return { message: entry.message, meta: { ...entry.meta, usage: emptyUsage() } };
  });
}
