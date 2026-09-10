import { extractText, type ContentPart, type Message } from '#/llm/message';
import type { ToolMessageConversion } from '#/llm/requester/requester';

import type { OpenAIContentPart, OpenAIWireMessage } from './contract';
import { TOOL_RESULT_MEDIA_PLACEHOLDER } from './patterns';
import { DEFAULT_REASONING_KEY, REASONING_DETAILS_KEY } from './reasoning-key';

const OMITTED_AUDIO_PLACEHOLDER = '(audio omitted: not supported by this provider)';
const OMITTED_VIDEO_PLACEHOLDER = '(video omitted: not supported by this provider)';

function convertContentPart(part: ContentPart): OpenAIContentPart | null {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think':
      return null;
    case 'image_url':
      return {
        type: 'image_url',
        image_url:
          part.imageUrl.id === undefined
            ? { url: part.imageUrl.url }
            : { url: part.imageUrl.url, id: part.imageUrl.id },
      };
    case 'audio_url':
      return {
        type: 'audio_url',
        audio_url:
          part.audioUrl.id === undefined
            ? { url: part.audioUrl.url }
            : { url: part.audioUrl.url, id: part.audioUrl.id },
      };
    case 'video_url':
      return {
        type: 'video_url',
        video_url:
          part.videoUrl.id === undefined
            ? { url: part.videoUrl.url }
            : { url: part.videoUrl.url, id: part.videoUrl.id },
      };
  }
}

function convertToolMessageMediaText(message: Message): string {
  const text = extractText(message);
  const lines: string[] = text.length > 0 ? [text] : [];
  if (message.content.some((part) => part.type === 'audio_url')) {
    lines.push(OMITTED_AUDIO_PLACEHOLDER);
  }
  if (
    message.content.some(
      (part) => part.type === 'video_url' && part.videoUrl.url.startsWith('data:'),
    )
  ) {
    lines.push(OMITTED_VIDEO_PLACEHOLDER);
  }
  if (lines.length === 0 && message.content.some((part) => part.type === 'image_url')) {
    return TOOL_RESULT_MEDIA_PLACEHOLDER;
  }
  return lines.join('\n');
}

export interface OpenAILowerContext {
  readonly reasoningKey: string;
  readonly preserveThinking: boolean;
  readonly toolMessageConversion: ToolMessageConversion | undefined;
}

export function lowerMessage(message: Message, lower: OpenAILowerContext): OpenAIWireMessage[] {
  const { reasoningKey, preserveThinking } = lower;
  let reasoningContent = '';
  let hasReasoningPart = false;
  const nonThinkParts: ContentPart[] = [];
  for (const part of message.content) {
    if (part.type === 'think') {
      hasReasoningPart = true;
      reasoningContent += part.think;
    } else {
      nonThinkParts.push(part);
    }
  }
  let content: string | OpenAIContentPart[] | undefined;
  if (message.role === 'tool' && lower.toolMessageConversion !== 'keep_parts') {
    content = message.content.some((part) => part.type !== 'text' && part.type !== 'think')
      ? convertToolMessageMediaText(message)
      : extractText(message);
  } else {
    const firstPart = nonThinkParts[0];
    if (nonThinkParts.length === 1 && firstPart?.type === 'text') {
      content = firstPart.text;
    } else if (nonThinkParts.length > 0) {
      content = nonThinkParts
        .map((part) => convertContentPart(part))
        .filter((part): part is OpenAIContentPart => part !== null);
    }
  }
  let converted: OpenAIWireMessage;
  if (message.role === 'assistant') {
    converted = {
      role: 'assistant',
      content:
        content !== undefined
          ? content
          : hasReasoningPart && message.toolCalls.length === 0
            ? ''
            : null,
      tool_calls:
        message.toolCalls.length > 0
          ? message.toolCalls.map((toolCall) => ({
              id: toolCall.id,
              type: 'function' as const,
              function: { name: toolCall.name, arguments: toolCall.arguments ?? '' },
            }))
          : undefined,
    };
  } else if (message.role === 'tool') {
    converted = { role: 'tool', tool_call_id: message.toolCallId, content: content ?? '' };
  } else {
    converted = { role: message.role, content: content ?? '' };
  }
  const reasoningDetails: Record<string, unknown>[] = [];
  for (const part of message.content) {
    if (part.type !== 'think' || part.detailsIndex === undefined) continue;
    if (part.think.length > 0) {
      reasoningDetails.push({ type: 'summary', summary: part.think });
    }
    if (part.encrypted !== undefined) {
      reasoningDetails.push({ type: 'encrypted', encrypted: part.encrypted });
    }
  }
  if (reasoningDetails.length > 0) {
    (converted as Record<string, unknown>)[REASONING_DETAILS_KEY] = reasoningDetails;
    (converted as Record<string, unknown>)[DEFAULT_REASONING_KEY] = reasoningContent;
  } else if (hasReasoningPart || (preserveThinking && message.role === 'assistant')) {
    (converted as Record<string, unknown>)[reasoningKey] = reasoningContent;
  }
  return [converted];
}
