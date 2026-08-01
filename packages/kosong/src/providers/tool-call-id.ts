import type { Message, ToolCall } from '#/message';

export interface ToolCallIdPolicy {
  normalize: (id: string) => string;
  maxLength?: number;
}

const EMPTY_TOOL_CALL_ID = 'tool_call';
const TOOL_CALL_ID_SAFE_CHARS = /[^a-zA-Z0-9_-]/g;

export function sanitizeToolCallId(id: string, maxLength?: number): string {
  const sanitized = id.replace(TOOL_CALL_ID_SAFE_CHARS, '_');
  return maxLength === undefined ? sanitized : sanitized.slice(0, maxLength);
}

// Kimi-K2 tool-call ids use the canonical native shape `functions.<name>:<idx>` — the exact format
// the model is trained to see echoed back in conversation history. Sanitizing it (`.` and `:` become
// `_`) makes the model emit reasoning with no tool call and stop the turn (`APIEmptyResponseError` /
// `finishReason=stop`). Such an id is also a valid free-form id for OpenAI-compatible providers —
// the transport that serves self-hosted Kimi (litellm / vLLM / SGLang / Azure) — so those policies
// opt into preserving it verbatim, while charset-restricted providers (Anthropic,
// `^[a-zA-Z0-9_-]+$`) keep sanitizing.
//
// The guard is keyed on the id shape rather than on the provider, because self-hosted Kimi is
// configured as a plain `openai` provider and does not self-identify at the policy layer. Trade-off:
// a Kimi-authored id replayed onto a different, stricter OpenAI-compatible backend is passed through
// rather than sanitized.
//
// Refs: Moonshot's tool_call_guidance.md; vLLM's "Debugging Kimi K2 Tool-Calling" writeup.
const KIMI_NATIVE_TOOL_CALL_ID = /^functions\.[A-Za-z0-9_-]+:\d+$/;

/**
 * Preserve a canonical native id verbatim; sanitize every other id.
 *
 * A preserved id is never length-capped: the chat-completions `tool_call.id` has no limit in the
 * OpenAI schema (the 64-char cap applies to the function *name*, `^[a-zA-Z0-9_-]{1,64}$`), and a
 * long tool name or a multi-digit `idx` must still round-trip intact. Hence `fallbackMaxLength`,
 * which bounds the sanitized fallback only — deliberately unlike
 * `sanitizeOpenAIResponsesCallIdPreservingNative`, whose cap is a real wire limit and therefore
 * also gates preservation.
 */
export function sanitizeToolCallIdPreservingNative(
  id: string,
  fallbackMaxLength?: number,
): string {
  return KIMI_NATIVE_TOOL_CALL_ID.test(id) ? id : sanitizeToolCallId(id, fallbackMaxLength);
}

function isPreservableResponsesCallId(id: string, maxLength?: number): boolean {
  return KIMI_NATIVE_TOOL_CALL_ID.test(id) && (maxLength === undefined || id.length <= maxLength);
}

export function sanitizeOpenAIResponsesCallId(id: string, maxLength?: number): string {
  const [callId] = id.split('|', 1);
  return sanitizeToolCallId(callId ?? id, maxLength);
}

/**
 * Preserve a canonical native id verbatim, but only when it fits `maxLength`; sanitize every other
 * id.
 *
 * Unlike the chat `tool_call.id`, the Responses `call_id` carries a real `maxLength` (64) on the
 * wire, and a preserved id is sent untruncated — so an over-long canonical id must fall back to
 * normalization rather than be rejected by the API.
 */
export function sanitizeOpenAIResponsesCallIdPreservingNative(
  id: string,
  maxLength?: number,
): string {
  // Mirror `sanitizeOpenAIResponsesCallId` and drop the `|<itemId>` suffix first, so a canonical
  // native id survives even when the Responses transport has appended an item id.
  const [callId] = id.split('|', 1);
  const base = callId ?? id;
  return isPreservableResponsesCallId(base, maxLength)
    ? base
    : sanitizeOpenAIResponsesCallId(id, maxLength);
}

export function normalizeToolCallIdsForProvider(
  messages: Message[],
  policy: ToolCallIdPolicy,
): Message[] {
  const rawIds = collectToolCallIds(messages);
  if (rawIds.length === 0) return messages;

  const mappedIds = buildToolCallIdMap(rawIds, policy);
  let changed = false;
  const normalizedMessages = messages.map((message) => {
    let messageChanged = false;
    let toolCalls = message.toolCalls;

    if (message.toolCalls.length > 0) {
      toolCalls = message.toolCalls.map((toolCall) => {
        const mappedId = mappedIds.get(toolCall.id);
        if (mappedId === undefined || mappedId === toolCall.id) return toolCall;
        messageChanged = true;
        return { ...toolCall, id: mappedId } satisfies ToolCall;
      });
    }

    const toolCallId =
      message.toolCallId === undefined ? undefined : mappedIds.get(message.toolCallId);
    const mappedToolCallId = toolCallId ?? message.toolCallId;
    if (mappedToolCallId !== message.toolCallId) {
      messageChanged = true;
    }

    if (!messageChanged) return message;
    changed = true;
    return { ...message, toolCalls, toolCallId: mappedToolCallId };
  });

  return changed ? normalizedMessages : messages;
}

function collectToolCallIds(messages: Message[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const append = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };

  for (const message of messages) {
    for (const toolCall of message.toolCalls) {
      append(toolCall.id);
    }
    if (message.toolCallId !== undefined) {
      append(message.toolCallId);
    }
  }

  return ids;
}

function buildToolCallIdMap(
  rawIds: string[],
  policy: ToolCallIdPolicy,
): Map<string, string> {
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

function truncateToolCallId(
  base: string,
  maxLength: number | undefined,
  suffix: string,
): string {
  if (maxLength === undefined) return `${base}${suffix}`;
  const baseLength = maxLength - suffix.length;
  if (baseLength <= 0) {
    throw new Error(`Tool call id maxLength ${maxLength} is too small for suffix ${suffix}.`);
  }
  return `${base.slice(0, baseLength)}${suffix}`;
}
