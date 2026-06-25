import type { ContentPart, Message, Tool } from '@moonshot-ai/kosong';

const messageTokenEstimateCache = new WeakMap<Message, number>();

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
    return mod.nativeEstimateTokensBatch(texts);
  }
  let total = 0;
  for (const tool of tools) {
    total += tsEstimateTokens(tool.name);
    total += tsEstimateTokens(tool.description);
    total += tsEstimateTokens(JSON.stringify(tool.parameters));
  }
  return total;
}

export function estimateTokensForMessage(message: Message): number {
  const cached = messageTokenEstimateCache.get(message);
  if (cached !== undefined) {
    return cached;
  }

  let total: number;
  const mod = getNative();
  if (mod?.nativeEstimateTokensBatch) {
    const texts: string[] = [message.role];
    for (const part of message.content) {
      if (part.type === 'text') {
        texts.push(part.text);
      } else if (part.type === 'think') {
        texts.push(part.think);
      }
    }
    if (message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        texts.push(call.name);
        texts.push(JSON.stringify(call.arguments));
      }
    }
    total = mod.nativeEstimateTokensBatch(texts);
  } else {
    total = tsEstimateTokens(message.role);
    for (const part of message.content) {
      if (part.type === 'text') {
        total += tsEstimateTokens(part.text);
      } else if (part.type === 'think') {
        total += tsEstimateTokens(part.think);
      }
    }
    if (message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        total += tsEstimateTokens(call.name);
        total += tsEstimateTokens(JSON.stringify(call.arguments));
      }
    }
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

export function estimateTokensForContentPart(part: ContentPart): number {
  if (part.type === 'text') {
    return estimateTokens(part.text);
  } else if (part.type === 'think') {
    return estimateTokens(part.think);
  }
  return 0;
}
