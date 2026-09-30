import {
  isVacuousContentPart,
  type ContentPart,
  type Message,
  type ToolCall,
  type ToolMessage,
} from '#/llm/message';
import type { LlmNoticeSink } from '#/llm/response';

import { SyntaxRequestFormatError } from '../errors';

export interface ToolCallIdPolicy {
  normalize: (id: string) => string;
  maxLength?: number;
}

function sameMessages(left: readonly Message[], right: readonly Message[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function isBlankText(part: ContentPart): boolean {
  return part.type === 'text' && part.text.trim().length === 0;
}

export function verifyToolExchanges(messages: readonly Message[]): readonly Message[] {
  const calls = new Set<string>();
  const answered = new Set<string>();
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) {
        if (calls.has(call.id)) {
          throw new SyntaxRequestFormatError(`Tool call id '${call.id}' is used by more than one tool call.`);
        }
        calls.add(call.id);
      }
    }
    if (message.role !== 'tool') continue;
    const id = message.toolCallId;
    if (!calls.has(id)) {
      throw new SyntaxRequestFormatError(`Tool result '${id}' has no preceding tool call.`);
    }
    if (answered.has(id)) {
      throw new SyntaxRequestFormatError(`Tool call '${id}' has more than one result.`);
    }
    if (message.content.every(isBlankText)) {
      throw new SyntaxRequestFormatError(`Tool result for '${id}' is empty.`);
    }
    answered.add(id);
  }
  const unanswered = [...calls].filter((id) => !answered.has(id));
  if (unanswered.length > 0) {
    throw new SyntaxRequestFormatError(`Tool calls without a result: ${unanswered.join(', ')}.`);
  }
  return messages;
}

function dropBlankText(message: Message, report: LlmNoticeSink): ContentPart[] {
  if (!message.content.some(isBlankText)) return message.content;
  const kept: ContentPart[] = [];
  for (const part of message.content) {
    if (!isBlankText(part)) {
      kept.push(part);
    } else if (part.type === 'text' && part.text.length > 0) {
      report({
        code: 'whitespace_text_dropped',
        message: `Dropped a whitespace-only text part from a ${message.role} message.`,
        data: { role: message.role },
      });
    }
  }
  return kept;
}

function carriesStructure(message: Message): boolean {
  if (message.role === 'assistant') return message.toolCalls.length > 0;
  if (message.role === 'system') return (message.tools?.length ?? 0) > 0;
  return message.role === 'tool';
}

export function cleanMessages(messages: readonly Message[], report: LlmNoticeSink): readonly Message[] {
  const out: Message[] = [];
  for (const message of messages) {
    const content = dropBlankText(message, report);
    if (!carriesStructure(message)) {
      if (content.length === 0) continue;
      if (content.every(isVacuousContentPart)) {
        report({
          code: 'vacuous_message_dropped',
          message: `Dropped a ${message.role} message without meaningful content.`,
          data: { role: message.role },
        });
        continue;
      }
    }
    out.push(content === message.content ? message : { ...message, content });
  }
  return sameMessages(out, messages) ? messages : out;
}

export function pairToolExchanges(
  messages: readonly Message[],
  report: LlmNoticeSink,
): readonly Message[] {
  const results = new Map<string, ToolMessage>();
  const pending = new Set<string>();
  const crossed = new Set<string>();
  for (const message of messages) {
    if (message.role === 'tool') {
      results.set(message.toolCallId, message);
      pending.delete(message.toolCallId);
      if (crossed.has(message.toolCallId)) {
        report({
          code: 'tool_result_reordered',
          message: `Moved the result of tool call '${message.toolCallId}' next to its call.`,
          data: { toolCallId: message.toolCallId },
        });
      }
      continue;
    }
    for (const id of pending) crossed.add(id);
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) pending.add(call.id);
    }
  }

  const out: Message[] = [];
  for (const message of messages) {
    if (message.role === 'tool') continue;
    out.push(message);
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls) out.push(results.get(call.id)!);
  }
  return sameMessages(out, messages) ? messages : out;
}

export function legalizeStructure(messages: readonly Message[], report: LlmNoticeSink): readonly Message[] {
  return pairToolExchanges(cleanMessages(messages, report), report);
}

const EMPTY_TOOL_CALL_ID = 'tool_call';

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
