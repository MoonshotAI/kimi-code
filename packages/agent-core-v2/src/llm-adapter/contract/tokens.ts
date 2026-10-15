import type { ContentPart, Message, Tool } from './message';

const messageTokenEstimateCache = new WeakMap<Message, number>();

export function estimateTokens(text: string): number {
  return countTokensWithAsciiRatio(text, 4);
}

export function estimateTokensConservative(text: string): number {
  return countTokensWithAsciiRatio(text, 1.5);
}

function countTokensWithAsciiRatio(text: string, charsPerToken: number): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / charsPerToken) + nonAsciiCount;
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
  const estimateText = message.role === 'tool' ? estimateTokensConservative : estimateTokens;
  for (const part of message.content) {
    total += estimateTokensForContentPart(part, estimateText);
  }
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

export function estimateTokensForContentPart(
  part: ContentPart,
  estimateText: (text: string) => number = estimateTokens,
): number {
  switch (part.type) {
    case 'text':
      return estimateText(part.text);
    case 'think':
      return estimateText(part.think);
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
