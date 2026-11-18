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

export function normalizeToolCallIdsForProvider(
  messages: readonly Message[],
  policy: ToolCallIdPolicy,
): Message[] {
  return [...legalizeToolCallIds(messages, policy)];
}
