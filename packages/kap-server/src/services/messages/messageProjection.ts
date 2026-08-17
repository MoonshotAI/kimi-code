/**
 * `ContextMessage` → v1 wire `Message` projection.
 *
 * Mirrors the v1 protocol projection so the `messages`, `snapshot`, and
 * `sessions` (`:undo`) surfaces produce byte-compatible message objects.
 * Lives in kap-server (next to the wire schema in `protocol/message.ts`) —
 * the engine speaks only the native `ContextMessage`.
 *
 * Tool results project to a single `tool_result` part: plain-text results keep
 * the historical flattened-text output, while a result carrying media parts
 * (image/video/audio — e.g. ReadMediaFile) passes the raw kosong content-part
 * array through, the same shape the live `tool.result` event stream carries,
 * so REST consumers can still render the media after reload/resume.
 *
 * A user `image_url` / `video_url` part projects to a structured `image` /
 * `video` content part so REST consumers can render it: an internal
 * `kimi-file://<id>` reference becomes
 * `{ kind: 'session_media', file_id }` (the internal URL never reaches
 * clients); any other url becomes `{ kind: 'url' }` carrying
 * the provider id. An `audio_url` part still flattens to a text marker.
 *
 * A daemon-ref media part is self-contained (`daemonFileRefFromPart`): the
 * part type carries the kind and the reference the file id, so the
 * projection walks the raw parts directly — there is no tag+ref pairing to
 * fold. A standalone `<media path>` tag text part is user text or the legacy
 * degrade form and passes through verbatim. Assistant output passes through
 * verbatim.
 */

import { daemonFileRefFromPart, parseDaemonFileUrl, type ContentPart, type ContextMessage } from '@moonshot-ai/agent-core-v2';

import type { Message, MessageContent, MessageRole, ToolUseContent } from '../../protocol/message';

function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

function toProtocolRole(role: ContextMessage['role']): MessageRole {
  return role as MessageRole;
}

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
    case 'image_url': {
      // Same daemon-reference rule as `video_url`: an internal reference
      // projects to the Session-owned copy created during prompt intake.
      const ref = parseDaemonFileUrl(part.imageUrl.url);
      return ref !== undefined
        ? { type: 'image', source: { kind: 'session_media', file_id: ref.fileId } }
        : { type: 'image', source: { kind: 'url', url: part.imageUrl.url, id: part.imageUrl.id } };
    }
    case 'audio_url':
      return { type: 'text', text: `[audio:${part.audioUrl.url}]` };
    case 'video_url': {
      const ref = parseDaemonFileUrl(part.videoUrl.url);
      return ref !== undefined
        ? { type: 'video', source: { kind: 'session_media', file_id: ref.fileId } }
        : { type: 'video', source: { kind: 'url', url: part.videoUrl.url, id: part.videoUrl.id } };
    }
  }
}

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

  // User and assistant content both map part-by-part: daemon-ref media parts
  // are self-contained and project to `session_media` sources inside
  // `mapContentPart`; standalone `<media path>` tags stay text.
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
 * Prompt content (engine kosong parts) → the v1 wire `messageContentSchema`
 * shape. Shared by every prompt-queue surface — the REST prompt list, the
 * `prompt.steered` session event, and the transcript prompt entity — so a
 * self-contained daemon-ref media part projects back to
 * `{ kind: 'session_media', file_id }`: neither the transient App upload nor
 * the internal `kimi-file://` URL becomes the stored read-model contract.
 */
export function projectPromptContentParts(content: readonly ContentPart[]): MessageContent[] {
  const parts: MessageContent[] = [];
  for (const part of content) {
    const daemonRef = daemonFileRefFromPart(part);
    if (daemonRef !== undefined) {
      parts.push({
        type: daemonRef.kind,
        source: { kind: 'session_media', file_id: daemonRef.ref.fileId },
      });
      continue;
    }
    if (part.type === 'text') parts.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.imageUrl.url);
      parts.push(match === null
        ? { type: 'image', source: { kind: 'url', url: part.imageUrl.url, id: part.imageUrl.id } }
        : { type: 'image', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    } else if (part.type === 'video_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(part.videoUrl.url);
      parts.push(match === null
        ? { type: 'video', source: { kind: 'url', url: part.videoUrl.url, id: part.videoUrl.id } }
        : { type: 'video', source: { kind: 'base64', media_type: match[1]!, data: match[2]! } });
    }
  }
  return parts;
}

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
