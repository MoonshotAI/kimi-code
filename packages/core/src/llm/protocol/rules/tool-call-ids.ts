import {
  type AssistantMessage,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from '#/llm/message';

import { SyntaxRequestFormatError } from '../errors';
import { sanitizeToolCallId } from '../kit/ids';

export interface ToolCallIdPolicy {
  normalize: (id: string) => string;
  maxLength?: number;
}

export interface ToolCallIdNormalizer {
  normalizePart(part: StreamedMessagePart): StreamedMessagePart;
  finish(message: AssistantMessage): AssistantMessage;
}

const EMPTY_TOOL_CALL_ID = 'tool_call';
const DEFAULT_TOOL_CALL_ID_POLICY: ToolCallIdPolicy = {
  normalize: (id) => sanitizeToolCallId(id),
};

function sameMessages(left: readonly Message[], right: readonly Message[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
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
      for (const toolCall of message.toolCalls) append(toolCall.id);
    }
    if (message.role === 'tool') append(message.toolCallId);
  }
  return ids;
}

function buildToolCallIdMap(rawIds: readonly string[], policy: ToolCallIdPolicy): Map<string, string> {
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
  usedIds: ReadonlySet<string>,
  maxLength: number | undefined,
): string {
  const base = normalized.length > 0 ? normalized : EMPTY_TOOL_CALL_ID;
  const candidate = truncateToolCallId(base, maxLength, '');
  if (!usedIds.has(candidate)) return candidate;
  for (let i = 2; ; i++) {
    const suffixed = truncateToolCallId(base, maxLength, `_${i}`);
    if (!usedIds.has(suffixed)) return suffixed;
  }
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
        return { ...toolCall, id: mappedId } satisfies ToolCall;
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

interface IssuedToolCall {
  readonly sourceId: string;
  readonly id: string;
  readonly rawId: string | undefined;
}

export function createToolCallIdNormalizer(
  history: readonly Message[],
  policy: ToolCallIdPolicy = DEFAULT_TOOL_CALL_ID_POLICY,
): ToolCallIdNormalizer {
  const taken = new Set(collectToolCallIds(legalizeToolCallIds(history, policy)));
  const assignedByIndex = new Map<number | string, string>();
  const occurrencesByRawId = new Map<string, number>();
  const issued: IssuedToolCall[] = [];
  const finished = new WeakMap<AssistantMessage, AssistantMessage>();

  const assign = (rawId: string, streamIndex: number | string | undefined): string => {
    const existing = streamIndex === undefined ? undefined : assignedByIndex.get(streamIndex);
    if (existing !== undefined) return existing;
    const occurrence = occurrencesByRawId.get(rawId) ?? 0;
    occurrencesByRawId.set(rawId, occurrence + 1);
    const normalized = policy.normalize(rawId);
    const base = normalized.length > 0 ? normalized : EMPTY_TOOL_CALL_ID;
    let assigned = truncateToolCallId(base, policy.maxLength, '');
    if (occurrence > 0 || taken.has(assigned)) {
      let n = Math.max(occurrence + 1, 2);
      do {
        assigned = truncateToolCallId(base, policy.maxLength, `__${n}`);
        n += 1;
      } while (taken.has(assigned));
    }
    taken.add(assigned);
    if (streamIndex !== undefined) assignedByIndex.set(streamIndex, assigned);
    return assigned;
  };

  const normalizeCall = (call: ToolCall): ToolCall => {
    const id = assign(call.id, call._streamIndex);
    return id === call.id ? call : { ...call, id, rawId: call.rawId ?? call.id };
  };
  const record = (source: ToolCall, normalized: ToolCall): void => {
    issued.push({ sourceId: source.id, id: normalized.id, rawId: normalized.rawId });
  };

  return {
    normalizePart: (part) => {
      if (part.type !== 'function') return part;
      const normalized = normalizeCall(part);
      record(part, normalized);
      return normalized;
    },
    finish: (message) => {
      const existing = finished.get(message);
      if (existing !== undefined) return existing;
      const matched = new Set<number>();
      const occurrences = new Map<string, number>();
      let changed = false;
      const toolCalls = message.toolCalls.map((call) => {
        const occurrence = occurrences.get(call.id) ?? 0;
        occurrences.set(call.id, occurrence + 1);
        const issuedIndex = issued.findIndex(
          (candidate, index) =>
            !matched.has(index) && candidate.id === call.id && candidate.rawId === call.rawId,
        );
        if (issuedIndex >= 0) {
          matched.add(issuedIndex);
          return call;
        }
        let previousIndex = -1;
        let seen = 0;
        for (let index = 0; index < issued.length; index++) {
          const candidate = issued[index]!;
          if (matched.has(index) || candidate.sourceId !== call.id) continue;
          if (seen === occurrence) {
            previousIndex = index;
            break;
          }
          seen += 1;
        }
        if (previousIndex >= 0) {
          matched.add(previousIndex);
          const previous = issued[previousIndex]!;
          if (previous.id === call.id && previous.rawId === call.rawId) return call;
          changed = true;
          return { ...call, id: previous.id, rawId: previous.rawId };
        }
        const normalized = normalizeCall(call);
        if (normalized !== call) changed = true;
        record(call, normalized);
        matched.add(issued.length - 1);
        return normalized;
      });
      const result = changed ? { ...message, toolCalls } : message;
      finished.set(message, result);
      if (result !== message) finished.set(result, result);
      return result;
    },
  };
}
