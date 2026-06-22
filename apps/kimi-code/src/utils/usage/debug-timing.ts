export interface StepTimingInput {
  readonly llmFirstTokenLatencyMs?: number | undefined;
  readonly llmStreamDurationMs?: number | undefined;
  readonly usage?: { readonly output: number } | undefined;
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
  return `[Debug] ${parts.join(' | ')}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
