export interface StepTimingInput {
  readonly llmFirstTokenLatencyMs?: number | undefined;
  readonly llmStreamDurationMs?: number | undefined;
  readonly usage?: { readonly output: number } | undefined;
}

export function formatStepDebugTiming(input: StepTimingInput): string | undefined {
  const latency = input.llmFirstTokenLatencyMs;
  const streamMs = input.llmStreamDurationMs;
  if (latency === undefined || streamMs === undefined) return undefined;

  const parts: string[] = [`TTFT: ${formatDuration(latency)}`];
  const outputTokens = input.usage?.output;
  if (outputTokens !== undefined && outputTokens > 0 && streamMs > 0) {
    const tps = (outputTokens / (streamMs / 1000)).toFixed(1);
    parts.push(`TPS: ${tps} tok/s (${outputTokens} tokens in ${formatDuration(streamMs)})`);
  }
  return `[Debug] ${parts.join(' | ')}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
