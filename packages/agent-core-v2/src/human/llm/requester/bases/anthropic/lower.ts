import type { Message, TextPart } from '#/llm/message';
import { SyntaxRequestFormatError } from '#/llm/syntax-errors';

import type { AnthropicWireContentBlock, AnthropicWireMessage } from './contract';

type AnthropicWireImageBlock = Extract<AnthropicWireContentBlock, { type: 'image' }>;

type AnthropicWireVideoBlock = Extract<AnthropicWireContentBlock, { type: 'video' }>;

const SUPPORTED_B64_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/mpeg',
  'video/quicktime',
  'video/webm',
  'video/x-matroska',
  'video/x-msvideo',
  'video/x-flv',
  'video/3gpp',
]);

function imageUrlPartToAnthropic(
  url: string,
  acceptedMimes: ReadonlySet<string>,
): AnthropicWireImageBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new SyntaxRequestFormatError(`Invalid data URL for image: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!acceptedMimes.has(mediaType)) {
      throw new SyntaxRequestFormatError(
        `Unsupported media type for base64 image: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: 'image',
      source: { type: 'base64', data, media_type: mediaType },
    };
  }
  return {
    type: 'image',
    source: { type: 'url', url },
  };
}

function videoUrlPartToAnthropic(url: string): AnthropicWireVideoBlock {
  if (url.startsWith('data:')) {
    const withoutScheme = url.slice(5);
    const parts = withoutScheme.split(';base64,', 2);
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new SyntaxRequestFormatError(`Invalid data URL for video: ${url}`);
    }
    const mediaType = parts[0];
    const data = parts[1];
    if (!SUPPORTED_B64_VIDEO_TYPES.has(mediaType)) {
      throw new SyntaxRequestFormatError(
        `Unsupported media type for base64 video: ${mediaType}, url: ${url}`,
      );
    }
    return {
      type: 'video',
      source: { type: 'base64', media_type: mediaType, data },
    };
  }

  return {
    type: 'video',
    source: { type: 'url', url },
  };
}

function parseToolArguments(args: string | null): unknown {
  if (args === null || args.trim() === '') {
    return {};
  }
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

export function messageContent(message: AnthropicWireMessage): AnthropicWireContentBlock[] {
  return Array.isArray(message.content) ? message.content : [];
}

export function isAnthropicWireMessageEmpty(message: AnthropicWireMessage): boolean {
  return messageContent(message).length === 0;
}

export function lowerMessage(
  message: Message,
  acceptedMimes: ReadonlySet<string>,
): AnthropicWireMessage[] {
  const content: AnthropicWireContentBlock[] = [];
  if (message.role === 'system') {
    const text = message.content
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    content.push({ type: 'text', text: `<system>${text}</system>` });
  } else if (message.role === 'tool') {
    const blocks: AnthropicWireContentBlock[] = [];
    for (const part of message.content) {
      if (part.type === 'text') {
        if (part.text) {
          blocks.push({ type: 'text', text: part.text });
        }
      } else if (part.type === 'image_url') {
        blocks.push(imageUrlPartToAnthropic(part.imageUrl.url, acceptedMimes));
      } else if (part.type === 'video_url') {
        blocks.push(videoUrlPartToAnthropic(part.videoUrl.url));
      }
    }
    content.push({
      type: 'tool_result',
      tool_use_id: message.toolCallId,
      content: blocks,
    });
  } else {
    for (const part of message.content) {
      if (part.type === 'think') {
        if (part.encrypted !== undefined) {
          content.push({ type: 'thinking', thinking: part.think, signature: part.encrypted });
        } else {
          content.push({ type: 'thinking', thinking: part.think });
        }
      } else if (part.type === 'text') {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'image_url') {
        content.push(imageUrlPartToAnthropic(part.imageUrl.url, acceptedMimes));
      } else if (part.type === 'video_url') {
        content.push(videoUrlPartToAnthropic(part.videoUrl.url));
      }
    }
    if (message.role === 'assistant') {
      for (const toolCall of message.toolCalls) {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.name,
          input: parseToolArguments(toolCall.arguments),
        });
      }
    }
  }
  const converted: AnthropicWireMessage = {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content,
  };
  return [converted];
}
