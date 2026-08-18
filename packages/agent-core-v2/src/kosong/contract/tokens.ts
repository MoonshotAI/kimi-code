import type { ContentPart, Message } from './message';
import type { Tool } from './tool';

const messageTokenEstimateCache = new WeakMap<Message, number>();

/**
 * Estimate token count from character classes. The previous flat `ascii/4`
 * systematically under-counted symbol- and digit-dense tool output (`/4`
 * lands at ~0.6x of real BPE counts for JSON/logs) — the dangerous
 * direction for the remaining-window clamp, since it promises more free
 * context than exists. Divisors are calibrated per class against a
 * representative BPE (cl100k_base, measured 2026-07-09; see the band tests
 * in `test/_base/utils/tokens.test.ts`):
 * - letters and `_`: ~4 chars/token (identifiers and prose words; BPE keeps
 *   whole stems, so this slightly over-counts pure words — tolerated as it
 *   biases the budget clamp toward safe)
 * - digits and punctuation: ~2 chars/token (JSON/log/tool-output density)
 * - whitespace: ~8 chars/token (indentation runs collapse in BPE)
 * - non-ascii: 1 token/char (unchanged; CJK measures ~1.0 chars/token)
 */
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
      (code >= 65 && code <= 90) || // A-Z
      (code >= 97 && code <= 122) || // a-z
      code === 95 // _
    ) {
      wordCount += 1;
    } else {
      // digits and punctuation · tokenize denser than words
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
