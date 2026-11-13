/**
 * Runtime type guards for values that reach the loop from hooks and hosts: messages, tool calls, LLM
 * outcomes, and tool results.
 */
import type { AssistantMessage, Message, ToolCall } from '#/llm/message';
import type { LlmOutcome } from '#/llm/response';

export { isToolResult } from '#/tool/contract';

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

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return (
    isObject(value) &&
    value['role'] === 'assistant' &&
    isContent(value['content']) &&
    Array.isArray(value['toolCalls']) &&
    value['toolCalls'].every(isToolCall)
  );
}

export function isMessage(value: unknown): value is Message {
  if (!isObject(value) || !isContent(value['content'])) return false;
  switch (value['role']) {
    case 'system':
    case 'user':
      return true;
    case 'assistant':
      return isAssistantMessage(value);
    case 'tool':
      return typeof value['toolCallId'] === 'string';
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
