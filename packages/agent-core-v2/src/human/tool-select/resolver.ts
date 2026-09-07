import type { Message } from '#/llm/message';
import type { MessageResolver } from '#/llm/requester/machine';

import type { ToolSelectState } from './state';

export function createToolSelectMessageResolver(state: ToolSelectState): MessageResolver {
  return {
    id: 'tool-select',
    resolve: (messages) => {
      let shaped: Message[] | undefined;
      for (let i = 0; i < messages.length; i += 1) {
        const message = messages[i] as Message;
        const next = shapeMessage(message, state);
        if (next === message) {
          if (shaped !== undefined) shaped.push(message);
          continue;
        }
        shaped ??= messages.slice(0, i);
        if (next !== undefined) shaped.push(next);
      }
      return Promise.resolve(shaped ?? messages);
    },
  };
}

function shapeMessage(message: Message, state: ToolSelectState): Message | undefined {
  if (message.role !== 'system' || message.tools === undefined || message.tools.length === 0) {
    return message;
  }
  const kept = state.enabled()
    ? message.tools.filter((tool) => state.isLoadable(tool.name))
    : [];
  if (kept.length === message.tools.length) return message;
  if (kept.length > 0) return { ...message, tools: kept };
  if (message.content.length === 0) return undefined;
  const { tools: _tools, ...rest } = message;
  void _tools;
  return rest;
}
