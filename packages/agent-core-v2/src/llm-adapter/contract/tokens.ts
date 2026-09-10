import type { ContentPart, Message, Tool } from './message';

const messageTokenEstimateCache = new WeakMap<Message, number>();

export function estimateTokens(text: string): number {
  let wordCount = 0;
  let denseCount = 0;
  let whitespaceCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code > 127) {
      nonAsciiCount += 1;
    } else if (code <= 32 || code === 127) {
      whitespaceCount += 1;
    } else if (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      code === 95
    ) {
      wordCount += 1;
    } else {
      denseCount += 1;
    }
  }
  return (
    Math.ceil(wordCount / 4) +
    Math.ceil(denseCount / 2) +
    Math.ceil(whitespaceCount / 8) +
    nonAsciiCount
  );
}

export function estimateTokensForMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensForMessage(message);
  }
  return total;
}

export function estimateTokensForTools(tools: readonly Tool[]): number {
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name);
    total += estimateTokens(tool.description);
    total += estimateTokens(JSON.stringify(tool.parameters));
  }
  return total;
}

export function estimateTokensForMessage(message: Message): number {
  const cached = messageTokenEstimateCache.get(message);
  if (cached !== undefined) {
    return cached;
  }

  let total = estimateTokens(message.role);
  total += estimateTokensForContentParts(message.content);
  if (message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name);
      total += estimateTokens(JSON.stringify(call.arguments));
    }
  }
  messageTokenEstimateCache.set(message, total);
  return total;
}

export function estimateTokensForContentParts(parts: readonly ContentPart[]): number {
  let total = 0;
  for (const part of parts) {
    total += estimateTokensForContentPart(part);
  }
  return total;
}

export const MEDIA_TOKEN_ESTIMATE = 2000;

export function estimateTokensForContentPart(part: ContentPart): number {
  switch (part.type) {
    case 'text':
      return estimateTokens(part.text);
    case 'think':
      return estimateTokens(part.think);
    case 'image_url':
    case 'audio_url':
    case 'video_url':
      return MEDIA_TOKEN_ESTIMATE;
    default: {
      const exhaustive: never = part;
      void exhaustive;
      return 0;
    }
  }
}
