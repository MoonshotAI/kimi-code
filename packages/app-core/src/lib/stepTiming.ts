import type { ConversationRequestDebug, ConversationUsage } from '../conversation/types';

const MIN_STREAM_MS_FOR_TPS = 50;

export function requestInputTotal(usage: ConversationUsage): number {
  return usage.input_other + usage.input_cache_read + usage.input_cache_creation;
}

export function requestCacheHitRate(usage: ConversationUsage): number | undefined {
  const total = requestInputTotal(usage);
  return total <= 0 ? undefined : Math.round((usage.input_cache_read / total) * 100);
}

export function requestTps(debug: ConversationRequestDebug): number | undefined {
  const streamMs = debug.timing?.stream_ms;
  const output = debug.usage?.output;
  if (streamMs === undefined || streamMs < MIN_STREAM_MS_FOR_TPS || output === undefined || output <= 0) return undefined;
  return output / (streamMs / 1000);
}

export function formatStepMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
