/**
 * `contextMemory` protocol projection — `ContextMessage` → wire `Message`.
 *
 * Mirrors v1's `toProtocolMessage`
 * (`packages/agent-core/src/services/message/message.ts`) so the `messages`,
 * `snapshot`, and `sessions` (`:undo`) edge surfaces produce byte-compatible
 * message objects. Lives in agent-core-v2 (next to the `ContextMessage` data it
 * projects) so the `sessionLegacy` edge adapter can own the v1 `:undo` response
 * shape without duplicating the projection in the server layer.
 *
 * Tool results project to a single `tool_result` part: plain-text results keep
 * the historical flattened-text output, while a result carrying media parts
 * (image/video/audio — e.g. ReadMediaFile) passes the raw kosong content-part
 * array through, the same shape the live `tool.result` event stream carries,
 * so REST consumers can still render the media after reload/resume.
 */

import type { Message, MessageContent, MessageRole, ToolUseContent } from '@moonshot-ai/protocol';

import type { ContextMessage } from './types';

/** Derive a stable opaque message id from (sessionId, index) — fallback for legacy records that predate intrinsic message ids. */
function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

/** kosong's `Role` already matches the wire `MessageRole` — pass through. */
function toProtocolRole(role: ContextMessage['role']): MessageRole {
  return role as MessageRole;
}

/** Translate one kosong content part to a wire content part. */
function mapContentPart(part: ContextMessage['content'][number]): MessageContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think': {
      const sig = part.encrypted;
      return sig !== undefined
        ? { type: 'thinking', thinking: part.think, signature: sig }
        : { type: 'thinking', thinking: part.think };
    }
    case 'image_url':
      return {
        type: 'image',
        source: { kind: 'url', url: part.imageUrl.url },
      };
    case 'audio_url':
      return { type: 'text', text: `[audio:${part.audioUrl.url}]` };
    case 'video_url':
      return { type: 'text', text: `[video:${part.videoUrl.url}]` };
  }
}

/**
 * Build the protocol-shaped `Message.content[]` for one history entry:
 *   1. `tool` role → a single `tool_result` part. A result carrying media
 *      parts (e.g. ReadMediaFile) passes the raw kosong content-part array
 *      through — the same shape the live `tool.result` event stream carries —
 *      so REST consumers can still render the media; other results flatten
 *      to joined text. `is_error` mirrors `ContextMessage.isError`.
 *   2. other roles → each mapped content part, then one `tool_use` part per
 *      `ToolCall` (assistant only).
 */
function buildProtocolContent(msg: ContextMessage): MessageContent[] {
  if (msg.role === 'tool') {
    if (msg.toolCallId === undefined) {
      return msg.content.map((p) => mapContentPart(p));
    }
    const hasMediaPart = msg.content.some(
      (p) => p.type === 'image_url' || p.type === 'video_url' || p.type === 'audio_url',
    );
    const output: unknown = hasMediaPart
      ? msg.content
      : msg.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const part: MessageContent =
      msg.isError === true
        ? {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output,
            is_error: true,
          }
        : {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output,
          };
    return [part];
  }

  const base = msg.content.map((p) => mapContentPart(p));

  if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
    for (const call of msg.toolCalls) {
      let parsedInput: unknown = call.arguments;
      if (typeof call.arguments === 'string') {
        try {
          parsedInput = JSON.parse(call.arguments);
        } catch {
          parsedInput = call.arguments;
        }
      }
      const part: ToolUseContent = {
        type: 'tool_use',
        tool_call_id: call.id,
        tool_name: call.name,
        input: parsedInput,
      };
      base.push(part);
    }
  }

  return base;
}

/**
 * Convert one history entry into the protocol's `Message` shape. `created_at`
 * defaults to the session's `createdAt` plus the entry index; callers that
 * know the real record time pass `createdAtMsOverride` (v1: the wire record
 * time, nudged to stay strictly increasing).
 */
export function toProtocolMessage(
  sessionId: string,
  index: number,
  msg: ContextMessage,
  sessionCreatedAtMs: number,
  createdAtMsOverride?: number,
): Message {
  const id = msg.id ?? deriveMessageId(sessionId, index);
  const role = toProtocolRole(msg.role);
  const content = buildProtocolContent(msg);
  const createdAtMs = createdAtMsOverride ?? sessionCreatedAtMs + index;
  const metadata = msg.origin !== undefined ? { origin: msg.origin } : undefined;
  return {
    id,
    session_id: sessionId,
    role,
    content,
    created_at: new Date(createdAtMs).toISOString(),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
