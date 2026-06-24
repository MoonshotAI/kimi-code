import { formatTokenCount } from './usage-format';

interface DebugTokenUsage {
  readonly inputOther?: number;
  readonly inputCacheRead?: number;
  readonly inputCacheCreation?: number;
  readonly output?: number;
}

export interface StepTimingInput {
  readonly llmFirstTokenLatencyMs?: number;
  readonly llmStreamDurationMs?: number;
  readonly usage?: DebugTokenUsage;
}

// Decode TPS is only meaningful when the output actually streamed over a
// measurable window. Below this threshold the duration is dominated by
// `Date.now()`'s ~1ms quantization (short / single-chunk tool-call turns can
// drain in 1ms), so dividing output tokens by it would report inflated rates
// like tens of thousands of tok/s. In that case we report the raw counts
// instead of a meaningless ratio.
const MIN_STREAM_MS_FOR_TPS = 50;

export function formatStepDebugTiming(input: StepTimingInput): string | undefined {
  const latency = input.llmFirstTokenLatencyMs;
  const streamMs = input.llmStreamDurationMs;
  if (latency === undefined || streamMs === undefined) return undefined;

  const parts: string[] = [`TTFT: ${formatDuration(latency)}`];
  const outputTokens = input.usage?.output;
  if (outputTokens !== undefined && outputTokens > 0) {
    if (streamMs >= MIN_STREAM_MS_FOR_TPS) {
      const tps = (outputTokens / (streamMs / 1000)).toFixed(1);
      parts.push(`TPS: ${tps} tok/s (${outputTokens} tokens in ${formatDuration(streamMs)})`);
    } else {
      parts.push(
        `${outputTokens} tokens in ${formatDuration(streamMs)} (stream too short for TPS)`,
      );
    }
  }

  const inputTokens = usageInputTotal(input.usage);
  const hasInputUsage =
    input.usage !== undefined &&
    (input.usage.inputOther !== undefined ||
      input.usage.inputCacheRead !== undefined ||
      input.usage.inputCacheCreation !== undefined);
  if (hasInputUsage && (inputTokens > 0 || (outputTokens ?? 0) > 0)) {
    const cacheReadTokens = input.usage.inputCacheRead ?? 0;
    const cacheCreationTokens = input.usage.inputCacheCreation ?? 0;
    const cacheHitRate = inputTokens > 0 ? Math.round((cacheReadTokens / inputTokens) * 100) : 0;
    const cacheParts = [`cache read ${formatTokenCount(cacheReadTokens)} (${cacheHitRate}%)`];
    if (cacheCreationTokens > 0) {
      cacheParts.push(`write ${formatTokenCount(cacheCreationTokens)}`);
    }
    parts.push(`tokens in ${formatTokenCount(inputTokens)}`);
    parts.push(cacheParts.join(' / '));
  }

  return `[Debug] ${parts.join(' | ')}`;
}

function usageInputTotal(usage: DebugTokenUsage | undefined): number {
  if (usage === undefined) return 0;
  return (usage.inputOther ?? 0) + (usage.inputCacheRead ?? 0) + (usage.inputCacheCreation ?? 0);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
