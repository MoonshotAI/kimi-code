/**
 * `kosong/contract` domain (L0) — character-based token-count estimates for
 * messages, tools, and content parts.
 *
 * Estimates are heuristic (ASCII ≈ 4 chars/token, non-ASCII ≈ 1 token/char,
 * media parts a flat `MEDIA_TOKEN_ESTIMATE`); they size context windows and
 * compaction budgets, never billing. Per-message results are memoized on the
 * message object via a WeakMap.
 */

import type { ContentPart, Message } from './message';
import type { Tool } from './tool';

import { tryNativeEstimateTokens, tryNativeEstimateTokensBatch } from '#/_base/native-tools';

const messageTokenEstimateCache = new WeakMap<Message, number>();

/**
 * JSON/structured content tends to have more tokens per character than
 * natural language — short identifiers, brackets, colons, and commas each
 * tokenize into individual tokens. The raw heuristic (ascii/4) under-counts
 * these. A 1.3× multiplier on JSON-stringified content closes most of the
 * gap without paying for a real tokenizer.
 */
const JSON_TOKEN_MULTIPLIER = 1.3;

export function estimateTokens(text: string): number {
  const native = tryNativeEstimateTokens(text);
  if (native !== undefined) return native;
  return tsEstimateTokens(text);
}

function tsEstimateTokens(text: string): number {
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

/**
 * Estimate tokens for JSON-serialized content. The multiplier compensates
 * for the heuristic's under-counting of JSON's dense punctuation.
 */
function estimateTokensForJson(text: string): number {
  return Math.ceil(tsEstimateTokens(text) * JSON_TOKEN_MULTIPLIER);
}

export function estimateTokensForMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensForMessage(message);
  }
  return total;
}

export function estimateTokensForTools(tools: readonly Tool[]): number {
  const batch = tryNativeEstimateTokensBatch;
  if (batch !== undefined) {
    const texts: string[] = [];
    for (const tool of tools) {
      texts.push(tool.name);
      texts.push(tool.description);
      texts.push(JSON.stringify(tool.parameters));
    }
    const result = batch(texts);
    if (result !== undefined) {
      return Math.ceil(result * JSON_TOKEN_MULTIPLIER);
    }
  }
  let total = 0;
  for (const tool of tools) {
    total += estimateTokens(tool.name);
    total += estimateTokens(tool.description);
    total += estimateTokensForJson(JSON.stringify(tool.parameters));
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
      total += estimateTokensForJson(JSON.stringify(call.arguments));
    }
  }
  // Dynamic tool schema messages carry full tool definitions; without this the
  // injected schemas are invisible to every compaction budget and the context
  // overflows before compaction ever triggers.
  if (message.tools !== undefined) {
    total += estimateTokensForTools(message.tools);
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
