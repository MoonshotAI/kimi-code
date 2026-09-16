import type { ContextMessage } from '#/agent/contextMemory/types';
import type { HistoryMessage } from '#human/agent/turn';
import type { UserMessage } from '#human/llm/message';
import { emptyUsage } from '#human/llm/usage';

export const EMPTY_MACHINE_PROMPT: UserMessage = { role: 'user', content: [] };

export function historyEntryFromContext(message: ContextMessage): HistoryMessage {
  switch (message.role) {
    case 'system':
      return { message: { role: 'system', content: message.content, tools: message.tools }, meta: {} };
    case 'user':
      return { message: { role: 'user', content: message.content }, meta: {} };
    case 'assistant':
      return {
        message: { role: 'assistant', content: message.content, toolCalls: message.toolCalls },
        meta: { usage: emptyUsage() },
      };
    case 'tool':
      return {
        message: { role: 'tool', content: message.content, toolCallId: message.toolCallId ?? '' },
        meta: {},
      };
  }
}

export function historyFromContext(messages: readonly ContextMessage[]): HistoryMessage[] {
  return messages.map(historyEntryFromContext);
}
