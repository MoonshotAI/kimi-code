import type { ContentPart, Message, Tool } from '@moonshot-ai/kosong';

/**
 * Structural subset of kosong's {@link Message} that token estimation reads.
 * Accepting the subset (instead of the full `Message`) lets callers with
 * message-shaped objects — such as the compaction helpers in `handoff.ts`,
 * which carry only `role`/`content`/`origin` — estimate tokens without an
 * unsafe cast, while full `Message` values still satisfy it.
 */
interface TokenEstimatableMessage {
  readonly role: string;
  readonly content: readonly ContentPart[];
  readonly toolCalls?: readonly { readonly name: string; readonly arguments: unknown }[];
  readonly tools?: readonly Tool[] | undefined;
}

const messageTokenEstimateCache = new WeakMap<TokenEstimatableMessage, number>();

// ── Native module loading (lazy, with TS fallback) ──────────────────────────

let nativeModule: {
  nativeEstimateTokens?: (text: string) => number;
  nativeEstimateTokensBatch?: (texts: string[]) => number;
} | null | undefined;

function getNative() {
  if (nativeModule === null) return undefined;
  if (nativeModule !== undefined) return nativeModule;
  try {
    nativeModule = require('@moonshot-ai/kimi-native-tools');
    return nativeModule;
  } catch {
    nativeModule = null;
    return undefined;
  }
}

// ── TS fallback implementations ─────────────────────────────────────────────

/**
 * JSON/structured content tends to have more tokens per character than
 * natural language — short identifiers, brackets, colons, and commas each
 * tokenize into individual tokens. The raw heuristic (ascii/4) under-counts
 * these. A 1.3× multiplier on JSON-stringified content closes most of the
 * gap without paying for a real tokenizer.
 */
const JSON_TOKEN_MULTIPLIER = 1.3;

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

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Estimate token count from text using a character-based heuristic.
 *   - ASCII (~4 chars per token)
 *   - CJK and other non-ASCII (~1 char per token)
 * The estimate is transient — the next LLM call returns the real count
 * and supersedes this value. Used to keep `tokenCountWithPending`
 * monotonic between LLM round-trips without paying for a tokenizer.
 */
export function estimateTokens(text: string): number {
  const mod = getNative();
  if (mod?.nativeEstimateTokens) return mod.nativeEstimateTokens(text);
  return tsEstimateTokens(text);
}

export function estimateTokensForMessages(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateTokensForMessage(message);
  }
  return total;
}

export function estimateTokensForTools(tools: readonly Tool[]): number {
  const mod = getNative();
  if (mod?.nativeEstimateTokensBatch) {
    const texts: string[] = [];
    for (const tool of tools) {
      texts.push(tool.name);
      texts.push(tool.description);
      texts.push(JSON.stringify(tool.parameters));
    }
    return Math.ceil(mod.nativeEstimateTokensBatch(texts) * JSON_TOKEN_MULTIPLIER);
  }
  let total = 0;
  for (const tool of tools) {
    total += tsEstimateTokens(tool.name);
    total += tsEstimateTokens(tool.description);
    total += estimateTokensForJson(JSON.stringify(tool.parameters));
  }
  return total;
}

export function estimateTokensForMessage(message: TokenEstimatableMessage): number {
  const cached = messageTokenEstimateCache.get(message);
  if (cached !== undefined) {
    return cached;
  }

  let total: number;
  const mod = getNative();
  if (mod?.nativeEstimateTokensBatch) {
    const texts: string[] = [message.role];
    let mediaCount = 0;
    for (const part of message.content) {
      if (part.type === 'text') {
        texts.push(part.text);
      } else if (part.type === 'think') {
        texts.push(part.think);
      } else if (isMediaPart(part)) {
        mediaCount += 1;
      }
    }
    if (message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        texts.push(call.name);
        // JSON arguments need the multiplier too — see estimateTokensForJson.
        texts.push(JSON.stringify(call.arguments));
      }
    }
    total =
      Math.ceil(mod.nativeEstimateTokensBatch(texts) * (1 + (JSON_TOKEN_MULTIPLIER - 1) * 0.5)) +
      mediaCount * MEDIA_TOKEN_ESTIMATE;
  } else {
    total = tsEstimateTokens(message.role);
    for (const part of message.content) {
      if (part.type === 'text') {
        total += tsEstimateTokens(part.text);
      } else if (part.type === 'think') {
        total += tsEstimateTokens(part.think);
      } else if (isMediaPart(part)) {
        total += MEDIA_TOKEN_ESTIMATE;
      }
    }
    if (message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        total += tsEstimateTokens(call.name);
        total += estimateTokensForJson(JSON.stringify(call.arguments));
      }
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
  const mod = getNative();
  if (mod?.nativeEstimateTokensBatch) {
    const texts: string[] = [];
    for (const part of parts) {
      if (part.type === 'text') {
        texts.push(part.text);
      } else if (part.type === 'think') {
        texts.push(part.think);
      }
    }
    return mod.nativeEstimateTokensBatch(texts);
  }
  let total = 0;
  for (const part of parts) {
    if (part.type === 'text') {
      total += tsEstimateTokens(part.text);
    } else if (part.type === 'think') {
      total += tsEstimateTokens(part.think);
    }
  }
  return total;
}

/**
 * Transient per-part token floor for media (image/audio/video) whose real size
 * cannot be cheaply derived from a data URL without decoding it. Mirrors the
 * fixed ~2000-tokens-per-image estimate used elsewhere in the industry and, by
 * the same reasoning, deliberately does NOT count the base64 payload as text —
 * that would wildly over-count (a few MB of data URL would read as ~1M tokens).
 * The value is transient: the next LLM round-trip returns the real usage and
 * supersedes it. Its only job is to stop compaction triggers, the
 * overflow-shrink budget, the kept-user budget, and `tokensAfter` from treating
 * media parts as free.
 */
export const MEDIA_TOKEN_ESTIMATE = 2000;

function isMediaPart(part: ContentPart): boolean {
  return part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url';
}

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
      // Exhaustiveness guard: a new ContentPart kind must declare its estimate
      // here rather than silently counting as 0 (the CMP-03 defect).
      const _exhaustive: never = part;
      void _exhaustive;
      return 0;
    }
  }
}
