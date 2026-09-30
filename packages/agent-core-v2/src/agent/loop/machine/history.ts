import type { ContextMessage } from '#/agent/contextMemory/types';
import { toLlmMessage } from '#/llm-adapter/contract/message';
import type { HistoryMessage } from '#human/agent/turn';
import type { UserMessage } from '#human/llm/message';
import { emptyUsage } from '#human/llm/usage';

export const EMPTY_MACHINE_PROMPT: UserMessage = { role: 'user', content: [] };

export function historyEntryFromContext(message: ContextMessage): HistoryMessage {
  const converted = toLlmMessage(message);
  switch (converted.role) {
    case 'system':
      return { message: converted, meta: {} };
    case 'user':
      return { message: converted, meta: {} };
    case 'assistant':
      return { message: converted, meta: { usage: emptyUsage() } };
    case 'tool':
      return { message: converted, meta: {} };
  }
}

export function historyFromContext(messages: readonly ContextMessage[]): HistoryMessage[] {
  return messages.map(historyEntryFromContext);
}
