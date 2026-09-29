import {
  estimateMessageTokens,
  estimateTextTokens,
  grandTotal,
  type AssistantEntry,
  type HistoryMessage,
  type Message,
  type ToolDescription,
} from '@moonshot-ai/agent-core';

export type TokenCountingStrategy = 'measured+estimated' | 'measured' | 'estimated';

export interface ContextSize {
  readonly size: number;
  readonly measured: number;
  readonly estimated: number;
}

export interface TokenCountingRequest {
  readonly systemPrompt: string;
  readonly tools: readonly ToolDescription[];
  readonly messages: readonly Message[];
}

interface TokenAnchor {
  readonly length: number;
  readonly tokens: number;
}

function latestAnchor(history: readonly HistoryMessage[]): TokenAnchor {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (entry.message.role !== 'assistant') continue;
    const usage = (entry as AssistantEntry).meta?.usage;
    if (usage === undefined) continue;
    const tokens = grandTotal(usage);
    if (tokens <= 0) continue;
    return { length: i + 1, tokens };
  }
  return { length: 0, tokens: 0 };
}

function estimateEntries(entries: readonly HistoryMessage[]): number {
  let total = 0;
  for (const entry of entries) {
    total += estimateMessageTokens(entry.message);
  }
  return total;
}

function normalizeSliceIndex(index: number, length: number): number {
  if (index < 0) return Math.max(length + index, 0);
  return Math.min(index, length);
}

export function get(
  history: readonly HistoryMessage[],
  start?: number,
  end?: number,
): ContextSize {
  const from = normalizeSliceIndex(start ?? 0, history.length);
  const to = normalizeSliceIndex(end ?? history.length, history.length);
  const anchor = latestAnchor(history);
  const measuredEnd = Math.min(to, anchor.length);
  const estimatedStart = Math.max(from, anchor.length);
  const measured =
    from === 0 && measuredEnd === anchor.length
      ? anchor.tokens
      : estimateEntries(history.slice(from, measuredEnd));
  const estimated = estimateEntries(history.slice(estimatedStart, to));
  return { size: measured + estimated, measured, estimated };
}

export function latestMeasured(history: readonly HistoryMessage[]): number {
  return latestAnchor(history).tokens;
}

export function statusSize(
  history: readonly HistoryMessage[],
  strategy: TokenCountingStrategy,
): number {
  if (strategy === 'measured') return latestMeasured(history);
  if (strategy === 'estimated') return estimateEntries(history);
  return Math.max(get(history).size, latestMeasured(history));
}

export function requestSize(request: TokenCountingRequest): number {
  let total = estimateTextTokens(request.systemPrompt);
  total += estimateTextTokens(JSON.stringify(request.tools));
  for (const message of request.messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}
