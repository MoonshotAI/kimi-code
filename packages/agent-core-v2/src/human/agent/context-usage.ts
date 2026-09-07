import type { Message, ToolDescription } from '#/llm/message';
import type { TokenUsage } from '#/llm/usage';

import type { AssistantEntry, HistoryMessage } from './turn';

const MEDIA_TOKEN_ESTIMATE = 2000;

export interface ContextUsagePrefix {
  systemPrompt?: string;
  tools?: readonly ToolDescription[];
}

export function calculateContextTokens(usage: TokenUsage): number {
  return usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation + usage.output;
}

export function estimateTextTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if ((char.codePointAt(0) as number) <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

export function estimateMessageTokens(message: Message): number {
  let total = estimateTextTokens(message.role);
  for (const part of message.content) {
    switch (part.type) {
      case 'text':
        total += estimateTextTokens(part.text);
        break;
      case 'think':
        total += estimateTextTokens(part.think);
        break;
      case 'image_url':
      case 'audio_url':
      case 'video_url':
        total += MEDIA_TOKEN_ESTIMATE;
        break;
    }
  }
  if (message.role === 'assistant') {
    for (const call of message.toolCalls) {
      total += estimateTextTokens(call.name);
      total += estimateTextTokens(call.arguments ?? '');
    }
  }
  return total;
}

export function estimateUsedContextTokens(
  history: readonly HistoryMessage[],
  prefix?: ContextUsagePrefix,
): number {
  let lastUsageIndex = -1;
  let usageTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i] as HistoryMessage;
    if (entry.message.role !== 'assistant') continue;
    const tokens = calculateContextTokens((entry as AssistantEntry).meta.usage);
    if (tokens > 0) {
      lastUsageIndex = i;
      usageTokens = tokens;
      break;
    }
  }
  let tokens = usageTokens;
  for (let i = lastUsageIndex + 1; i < history.length; i++) {
    tokens += estimateMessageTokens((history[i] as HistoryMessage).message);
  }
  if (lastUsageIndex === -1 && prefix !== undefined) {
    if (prefix.systemPrompt !== undefined) {
      tokens += estimateTextTokens(prefix.systemPrompt);
    }
    if (prefix.tools !== undefined && prefix.tools.length > 0) {
      tokens += estimateTextTokens(JSON.stringify(prefix.tools));
    }
  }
  return tokens;
}
