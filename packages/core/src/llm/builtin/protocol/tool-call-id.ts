/**
 * Tool call id helpers for built-in protocols: OpenAI Responses call id sanitization and applying a
 * provider's id policy to a message list.
 */
import type { Message } from '#/llm/message';
import { sanitizeToolCallId } from '#/llm/protocol/kit/ids';
import {
  legalizeToolCallIds,
  type ToolCallIdPolicy,
} from '#/llm/protocol/rules/tool-call-ids';

export { sanitizeToolCallId } from '#/llm/protocol/kit/ids';

export function sanitizeOpenAIResponsesCallId(id: string, maxLength?: number): string {
  const [callId] = id.split('|', 1);
  return sanitizeToolCallId(callId ?? id, maxLength);
}

/**
 * Applies `legalizeToolCallIds` and returns a mutable message array, with matching call/result ids
 * normalized consistently and colliding ids made unique.
 *
 * @example
 * // With `policy.normalize = (id) => id.toLowerCase()`:
 * // Input:
 * {
 *   role: 'assistant',
 *   content: [],
 *   toolCalls: [
 *     { type: 'function', id: 'Read', name: 'read', arguments: '{}' }, // ←
 *     { type: 'function', id: 'read', name: 'read', arguments: '{}' }, // ←
 *   ],
 * }
 * // Output:
 * {
 *   role: 'assistant',
 *   content: [],
 *   toolCalls: [
 *     { type: 'function', id: 'read_2', name: 'read', arguments: '{}' }, // ←
 *     { type: 'function', id: 'read', name: 'read', arguments: '{}' }, // ←
 *   ],
 * }
 */
export function normalizeToolCallIdsForProvider(
  messages: readonly Message[],
  policy: ToolCallIdPolicy,
): Message[] {
  return [...legalizeToolCallIds(messages, policy)];
}
