import type { ContentPart, Message } from './message';
import type { Tool } from './tool';

/**
 * Estimate token count from text using a character-based heuristic.
 * ASCII (~4 chars/token), CJK and other non-ASCII (~1 char/token).
 */
export function estimateTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
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

function estimateTokensForMessage(message: Message): number {
  let total = estimateTokens(message.role);
  total += estimateTokensForContentParts(message.content);
  for (const call of message.toolCalls) {
    total += estimateTokens(call.name);
    total += estimateTokens(JSON.stringify(call.arguments));
  }
  return total;
}

function estimateTokensForContentParts(parts: readonly ContentPart[]): number {
  let total = 0;
  for (const part of parts) {
    if (part.type === 'text') {
      total += estimateTokens(part.text);
    } else if (part.type === 'think') {
      total += estimateTokens(part.think);
    } else if (part.type === 'image_url') {
      total += estimateTokens(part.imageUrl.url);
    } else if (part.type === 'audio_url') {
      total += estimateTokens(part.audioUrl.url);
    } else if (part.type === 'video_url') {
      total += estimateTokens(part.videoUrl.url);
    }
  }
  return total;
}

export function estimatePromptTokens(args: {
  readonly systemPrompt: string;
  readonly history: readonly Message[];
  readonly tools: readonly Tool[];
}): number {
  return (
    estimateTokens(args.systemPrompt) +
    estimateTokensForMessages(args.history) +
    estimateTokensForTools(args.tools)
  );
}
