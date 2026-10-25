import { daemonFileRefFromPart, parseDaemonFileUrl, type ContextMessage } from '@moonshot-ai/agent-core-v2';
import { fromCorePart } from '@moonshot-ai/agent-core-v2/human/message';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';

import type { Message, MessageContent, MessageRole, ToolUseContent } from '../../protocol/message';

function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

function toProtocolRole(role: ContextMessage['role']): MessageRole {
  return role as MessageRole;
}

function mapContentPart(part: ContextMessage['content'][number]): MessageContent {
  const legacy = fromCorePart(part);
  switch (legacy.type) {
    case 'text':
      return { type: 'text', text: legacy.text };
    case 'think': {
      const sig = legacy.encrypted;
      return sig !== undefined
        ? { type: 'thinking', thinking: legacy.think, signature: sig }
        : { type: 'thinking', thinking: legacy.think };
    }
    case 'image_url': {
      const ref = parseDaemonFileUrl(legacy.imageUrl.url);
      return ref !== undefined
        ? { type: 'image', source: { kind: 'session_media', file_id: ref.fileId }, name: legacy.imageUrl.name }
        : { type: 'image', source: { kind: 'url', url: legacy.imageUrl.url, id: legacy.imageUrl.id }, name: legacy.imageUrl.name };
    }
    case 'audio_url':
      return { type: 'text', text: `[audio:${legacy.audioUrl.url}]` };
    case 'video_url': {
      const ref = parseDaemonFileUrl(legacy.videoUrl.url);
      return ref !== undefined
        ? { type: 'video', source: { kind: 'session_media', file_id: ref.fileId }, name: legacy.videoUrl.name }
        : { type: 'video', source: { kind: 'url', url: legacy.videoUrl.url, id: legacy.videoUrl.id }, name: legacy.videoUrl.name };
    }
  }
}

function isCoreMediaPart(
  part: unknown,
): part is Extract<ContentPart, { type: 'image_url' | 'audio_url' | 'video_url' }> {
  if (typeof part !== 'object' || part === null || !('type' in part) || !('source' in part)) {
    return false;
  }
  if (part.type !== 'image_url' && part.type !== 'audio_url' && part.type !== 'video_url') {
    return false;
  }
  const source = part.source;
  if (typeof source !== 'object' || source === null || !('kind' in source)) return false;
  return (
    source.kind === 'url' ||
    source.kind === 'inline' ||
    source.kind === 'file' ||
    source.kind === 'store'
  );
}

export function projectToolResultOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output;
  return output.map((part) => (isCoreMediaPart(part) ? fromCorePart(part) : part));
}

function buildProtocolContent(msg: ContextMessage): MessageContent[] {
  const visibleContent = msg.content.filter((p) => p.type !== 'think' || p.hidden !== true);
  if (msg.role === 'tool') {
    if (msg.toolCallId === undefined) {
      return visibleContent.map((p) => mapContentPart(p));
    }
    const hasMediaPart = visibleContent.some(
      (p) => p.type === 'image_url' || p.type === 'video_url' || p.type === 'audio_url',
    );
    const output: unknown = hasMediaPart
      ? projectToolResultOutput(visibleContent)
      : visibleContent.map((p) => (p.type === 'text' ? p.text : '')).join('');
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

  const base = visibleContent.map((p) => mapContentPart(p));

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

export function projectPromptContentParts(content: readonly ContentPart[]): MessageContent[] {
  const parts: MessageContent[] = [];
  for (const part of content) {
    const daemonRef = daemonFileRefFromPart(part);
    const legacy = fromCorePart(part);
    if (daemonRef !== undefined) {
      parts.push({
        type: daemonRef.kind,
        source: { kind: 'session_media', file_id: daemonRef.ref.fileId },
        name:
          legacy.type === 'image_url'
            ? legacy.imageUrl.name
            : legacy.type === 'video_url'
              ? legacy.videoUrl.name
              : undefined,
      });
      continue;
    }
    if (legacy.type === 'text') parts.push({ type: 'text', text: legacy.text });
    else if (legacy.type === 'image_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(legacy.imageUrl.url);
      parts.push(match === null
        ? { type: 'image', source: { kind: 'url', url: legacy.imageUrl.url, id: legacy.imageUrl.id }, name: legacy.imageUrl.name }
        : { type: 'image', source: { kind: 'base64', media_type: match[1]!, data: match[2]! }, name: legacy.imageUrl.name });
    } else if (legacy.type === 'video_url') {
      const match = /^data:([^;]+);base64,(.*)$/.exec(legacy.videoUrl.url);
      parts.push(match === null
        ? { type: 'video', source: { kind: 'url', url: legacy.videoUrl.url, id: legacy.videoUrl.id }, name: legacy.videoUrl.name }
        : { type: 'video', source: { kind: 'base64', media_type: match[1]!, data: match[2]! }, name: legacy.videoUrl.name });
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
