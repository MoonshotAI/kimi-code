import type { Message, ToolCall } from '#/llm/message';
import type { ToolCallIdPolicy } from '#/llm/requester/requester';
import { SyntaxRequestFormatError } from '#/llm/syntax-errors';

const EMPTY_TOOL_CALL_ID = 'tool_call';
const TOOL_CALL_ID_SAFE_CHARS = /[^a-zA-Z0-9_-]/g;

export function sanitizeToolCallId(id: string, maxLength?: number): string {
  const sanitized = id.replace(TOOL_CALL_ID_SAFE_CHARS, '_');
  return maxLength === undefined ? sanitized : sanitized.slice(0, maxLength);
}

export function sanitizeOpenAIResponsesCallId(id: string, maxLength?: number): string {
  const [callId] = id.split('|', 1);
  return sanitizeToolCallId(callId ?? id, maxLength);
}

export function normalizeToolCallIdsForProvider(
  messages: readonly Message[],
  policy: ToolCallIdPolicy,
): Message[] {
  const rawIds = collectToolCallIds(messages);
  if (rawIds.length === 0) return [...messages];

  const mappedIds = buildToolCallIdMap(rawIds, policy);
  let changed = false;
  const normalizedMessages = messages.map((message) => {
    if (message.role === 'assistant') {
      let messageChanged = false;
      const toolCalls = message.toolCalls.map((toolCall) => {
        const mappedId = mappedIds.get(toolCall.id);
        if (mappedId === undefined || mappedId === toolCall.id) return toolCall;
        messageChanged = true;
        return { ...toolCall, id: mappedId } satisfies ToolCall;
      });
      if (!messageChanged) return message;
      changed = true;
      return { ...message, toolCalls };
    }
    if (message.role === 'tool') {
      const mappedToolCallId = mappedIds.get(message.toolCallId) ?? message.toolCallId;
      if (mappedToolCallId === message.toolCallId) return message;
      changed = true;
      return { ...message, toolCallId: mappedToolCallId };
    }
    return message;
  });

  return changed ? normalizedMessages : [...messages];
}

function collectToolCallIds(messages: readonly Message[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const append = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls) {
        append(toolCall.id);
      }
    }
    if (message.role === 'tool') {
      append(message.toolCallId);
    }
  }

  return ids;
}

function buildToolCallIdMap(rawIds: string[], policy: ToolCallIdPolicy): Map<string, string> {
  const mappedIds = new Map<string, string>();
  const usedIds = new Set<string>();

  for (const rawId of rawIds) {
    const normalized = policy.normalize(rawId);
    if (normalized === rawId && normalized.length > 0) {
      mappedIds.set(rawId, normalized);
      usedIds.add(normalized);
    }
  }

  for (const rawId of rawIds) {
    if (mappedIds.has(rawId)) continue;
    const normalized = policy.normalize(rawId);
    const unique = makeUniqueToolCallId(normalized, usedIds, policy.maxLength);
    mappedIds.set(rawId, unique);
    usedIds.add(unique);
  }

  return mappedIds;
}

function makeUniqueToolCallId(
  normalized: string,
  usedIds: Set<string>,
  maxLength: number | undefined,
): string {
  const base = normalized.length > 0 ? normalized : EMPTY_TOOL_CALL_ID;
  const candidate = truncateToolCallId(base, maxLength, '');
  if (!usedIds.has(candidate)) return candidate;

  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const suffixed = truncateToolCallId(base, maxLength, suffix);
    if (!usedIds.has(suffixed)) return suffixed;
  }
}

function truncateToolCallId(base: string, maxLength: number | undefined, suffix: string): string {
  if (maxLength === undefined) return `${base}${suffix}`;
  const baseLength = maxLength - suffix.length;
  if (baseLength <= 0) {
    throw new SyntaxRequestFormatError(
      `Tool call id maxLength ${maxLength} is too small for suffix ${suffix}.`,
    );
  }
  return `${base.slice(0, baseLength)}${suffix}`;
}
