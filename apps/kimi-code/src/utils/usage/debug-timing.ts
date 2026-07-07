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
  /**
   * Split of `llmFirstTokenLatencyMs` into the client-side request-build
   * portion (`llmRequestBuildMs`) and the network + API-server portion
   * (`llmServerFirstTokenMs`). Both present together or not at all.
   */
  readonly llmRequestBuildMs?: number;
  readonly llmServerFirstTokenMs?: number;
  /**
   * Split of `llmStreamDurationMs` (the decode window) into server time spent
   * awaiting parts (`llmServerDecodeMs`) and client time spent processing parts
   * (`llmClientConsumeMs`). Both present together or not at all.
   */
  readonly llmServerDecodeMs?: number;
  readonly llmClientConsumeMs?: number;
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

  const parts: string[] = [`TTFT: ${formatTtft(input)}`];
  const outputTokens = input.usage?.output;
  if (outputTokens !== undefined && outputTokens > 0) {
    if (streamMs >= MIN_STREAM_MS_FOR_TPS) {
      const tps = (outputTokens / (streamMs / 1000)).toFixed(1);
      parts.push(
        `TPS: ${tps} tok/s (${outputTokens} tokens in ${formatDuration(streamMs)}${formatDecodeSplit(input)})`,
      );
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

// Render TTFT, splitting the latency into the network + API-server portion and
// the in-process request-build portion when the provider reported the
// boundary. Falls back to the bare total otherwise.
function formatTtft(input: StepTimingInput): string {
  const total = formatDuration(input.llmFirstTokenLatencyMs ?? 0);
  const build = input.llmRequestBuildMs;
  const server = input.llmServerFirstTokenMs;
  if (build === undefined || server === undefined) return total;
  return `${total} (api ${formatDuration(server)} + client ${formatDuration(build)})`;
}

// Render the decode-window split as a trailing clause, e.g.
// `; server 4.6s + client 0.4s`. A large client share means the host's per-part
// processing is throttling decode. Empty when the provider did not report it.
function formatDecodeSplit(input: StepTimingInput): string {
  const server = input.llmServerDecodeMs;
  const client = input.llmClientConsumeMs;
  if (server === undefined || client === undefined) return '';
  return `; server ${formatDuration(server)} + client ${formatDuration(client)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
