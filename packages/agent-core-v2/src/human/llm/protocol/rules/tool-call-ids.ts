import type { Message } from '#/llm/message';
import type { ToolCallIdPolicy } from '#/llm/requester/requester';
import { SyntaxRequestFormatError } from '#/llm/syntax-errors';

import type { DecodeSink } from '../protocol';

const EMPTY_TOOL_CALL_ID = 'tool_call';

function sameMessages(left: readonly Message[], right: readonly Message[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

export function legalizeToolCallIds(
  messages: readonly Message[],
  policy: ToolCallIdPolicy | undefined,
): readonly Message[] {
  if (policy === undefined) return messages;
  const rawIds = collectToolCallIds(messages);
  if (rawIds.length === 0) return messages;

  const mappedIds = buildToolCallIdMap(rawIds, policy);
  const normalizedMessages = messages.map((message) => {
    if (message.role === 'assistant') {
      let messageChanged = false;
      const toolCalls = message.toolCalls.map((toolCall) => {
        const mappedId = mappedIds.get(toolCall.id);
        if (mappedId === undefined || mappedId === toolCall.id) return toolCall;
        messageChanged = true;
        return { ...toolCall, id: mappedId };
      });
      return messageChanged ? { ...message, toolCalls } : message;
    }
    if (message.role === 'tool') {
      const mappedToolCallId = mappedIds.get(message.toolCallId) ?? message.toolCallId;
      return mappedToolCallId === message.toolCallId
        ? message
        : { ...message, toolCallId: mappedToolCallId };
    }
    return message;
  });

  return sameMessages(normalizedMessages, messages) ? messages : normalizedMessages;
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

export function uniqueToolCallIds<TSink extends DecodeSink>(
  history: readonly Message[],
  sink: TSink,
): TSink {
  const taken = new Set<string>();
  for (const message of history) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) taken.add(call.id);
    }
    if (message.role === 'tool') taken.add(message.toolCallId);
  }
  const assignedByIndex = new Map<number | string, string>();
  const occurrencesByRawId = new Map<string, number>();
  const assign = (rawId: string, streamIndex: number | string | undefined): string => {
    const existing = streamIndex === undefined ? undefined : assignedByIndex.get(streamIndex);
    if (existing !== undefined) return existing;
    const occurrence = occurrencesByRawId.get(rawId) ?? 0;
    occurrencesByRawId.set(rawId, occurrence + 1);
    let assigned = rawId;
    if (occurrence > 0 || taken.has(rawId)) {
      let n = Math.max(occurrence + 1, 2);
      while (taken.has(`${rawId}__${n}`)) n += 1;
      assigned = `${rawId}__${n}`;
    }
    taken.add(assigned);
    if (streamIndex !== undefined) assignedByIndex.set(streamIndex, assigned);
    return assigned;
  };
  return {
    ...sink,
    onDelta: (part) => {
      if (part.type !== 'function') return sink.onDelta(part);
      const id = assign(part.id, part._streamIndex);
      sink.onDelta(id === part.id ? part : { ...part, id, rawId: part.rawId ?? part.id });
    },
  };
}
