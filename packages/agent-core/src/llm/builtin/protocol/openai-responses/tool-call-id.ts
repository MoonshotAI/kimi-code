import { sanitizeToolCallId } from '#/llm/protocol/tool-call-id';

export function sanitizeOpenAIResponsesCallId(id: string, maxLength?: number): string {
  const [callId] = id.split('|', 1);
  return sanitizeToolCallId(callId ?? id, maxLength);
}
