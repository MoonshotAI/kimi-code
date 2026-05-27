import type { ContentPart, Message, Tool } from '@moonshot-ai/kosong';

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

export function estimateTokensForMessage(message: Message): number {
  let total = estimateTokens(message.role);
  for (const part of message.content) {
    total += estimateTokensForContentPart(part);
  }
  if (message.toolCalls !== undefined) {
    for (const call of message.toolCalls) {
      total += estimateTokens(call.name);
      total += estimateTokens(JSON.stringify(call.arguments));
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
