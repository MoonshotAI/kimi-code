import type { AssistantEntry, HistoryMessage, Message, ToolDescription } from '#/llm/message';

export type FinishReason =
  | 'completed'
  | 'tool_calls'
  | 'truncated'
  | 'filtered'
  | 'paused'
  | 'other';

export interface FinishInfo {
  readonly finishReason: FinishReason | null;
  readonly rawFinishReason: string | null;
}

export const NO_FINISH: FinishInfo = { finishReason: null, rawFinishReason: null };

export interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead: number;
  inputCacheCreation: number;
  raw?: Record<string, unknown>;
}

export function emptyUsage(): TokenUsage {
  return { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };
}

export function inputTotal(usage: TokenUsage): number {
  return usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
}

export function grandTotal(usage: TokenUsage): number {
  return inputTotal(usage) + usage.output;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputOther: a.inputOther + b.inputOther,
    output: a.output + b.output,
    inputCacheRead: a.inputCacheRead + b.inputCacheRead,
    inputCacheCreation: a.inputCacheCreation + b.inputCacheCreation,
  };
}

export function mergeUsagePatch(
  base: TokenUsage | undefined,
  patch: Partial<TokenUsage>,
): TokenUsage {
  return {
    inputOther: patch.inputOther ?? base?.inputOther ?? 0,
    output: patch.output ?? base?.output ?? 0,
    inputCacheRead: patch.inputCacheRead ?? base?.inputCacheRead ?? 0,
    inputCacheCreation: patch.inputCacheCreation ?? base?.inputCacheCreation ?? 0,
  };
}

const MEDIA_TOKEN_ESTIMATE = 2000;

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

export function usedContextTokens(
  history: readonly HistoryMessage[],
  prefix?: {
    systemPrompt?: string;
    tools?: readonly ToolDescription[];
  },
): number {
  let lastUsageIndex = -1;
  let usageTokens = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry === undefined || entry.message.role !== 'assistant') continue;
    const usage = (entry as AssistantEntry).meta?.usage;
    if (usage === undefined) continue;
    const tokens = grandTotal(usage);
    if (tokens > 0) {
      lastUsageIndex = i;
      usageTokens = tokens;
      break;
    }
  }
  let tokens = usageTokens;
  for (let i = lastUsageIndex + 1; i < history.length; i++) {
    const entry = history[i];
    if (entry === undefined) continue;
    tokens += estimateMessageTokens(entry.message);
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
