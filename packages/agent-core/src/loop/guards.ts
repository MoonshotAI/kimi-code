import type { AssistantMessage, ToolCall } from '#/llm/message';
import type { LlmOutcome } from '#/llm/response';
import type { HistoryMessage } from '#/history/message';
import type { ToolResult } from '#/tool/index';

export type Fields = Record<string, unknown>;

export function isObject(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isContent(value: unknown): boolean {
  return Array.isArray(value) && value.every((part) => isObject(part) && typeof part['type'] === 'string');
}

export function isToolCall(value: unknown): value is ToolCall {
  return isObject(value) && typeof value['id'] === 'string' && typeof value['name'] === 'string';
}

export function isToolResult(value: unknown): value is ToolResult {
  return isObject(value) && isContent(value['content']);
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isObject(value) &&
    value['role'] === 'assistant' &&
    isContent(value['content']) &&
    Array.isArray(value['toolCalls']) &&
    value['toolCalls'].every(isToolCall)
  );
}

export function isEntry(value: unknown): value is HistoryMessage {
  if (!isObject(value) || !isObject(value['message'])) return false;
  const message = value['message'];
  if (!isContent(message['content'])) return false;
  switch (message['role']) {
    case 'system':
    case 'user':
      return true;
    case 'assistant':
      return isAssistantMessage(message);
    case 'tool':
      return typeof message['toolCallId'] === 'string';
    default:
      return false;
  }
}

export function isLlmOutcome(value: unknown): value is LlmOutcome {
  if (!isObject(value)) return false;
  switch (value['type']) {
    case 'done':
      return isAssistantMessage(value['message']);
    case 'aborted':
      return value['message'] === null || isAssistantMessage(value['message']);
    case 'failed':
      return (
        isObject(value['error']) &&
        typeof value['error']['kind'] === 'string' &&
        typeof value['error']['message'] === 'string'
      );
    default:
      return false;
  }
}
