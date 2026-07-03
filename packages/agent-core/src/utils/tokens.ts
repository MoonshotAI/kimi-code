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
}

const messageTokenEstimateCache = new WeakMap<TokenEstimatableMessage, number>();

/**
 * Estimate token count from text using a character-based heuristic.
 *   - ASCII (~4 chars per token)
 *   - CJK and other non-ASCII (~1 char per token)
 * The estimate is transient — the next LLM call returns the real count
 * and supersedes this value. Used to keep `tokenCountWithPending`
 * monotonic between LLM round-trips without paying for a tokenizer.
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

export function estimateTokensForMessage(message: TokenEstimatableMessage): number {
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
