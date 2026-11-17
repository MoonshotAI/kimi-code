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
  readonly llmRequestBuildMs?: number;
  readonly llmServerFirstTokenMs?: number;
  readonly llmServerDecodeMs?: number;
  readonly llmClientConsumeMs?: number;
  readonly llmClientBlockedMs?: number;
  readonly usage?: DebugTokenUsage;
}

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

function formatTtft(input: StepTimingInput): string {
  const total = formatDuration(input.llmFirstTokenLatencyMs ?? 0);
  const build = input.llmRequestBuildMs;
  const server = input.llmServerFirstTokenMs;
  if (build === undefined || server === undefined) return total;
  return `${total} (api ${formatDuration(server)} + client ${formatDuration(build)})`;
}

function formatDecodeSplit(input: StepTimingInput): string {
  const server = input.llmServerDecodeMs;
  const client = input.llmClientConsumeMs;
  if (server === undefined || client === undefined) return '';
  const blocked = input.llmClientBlockedMs;
  const blockedPart = blocked === undefined ? '' : ` (busy ${formatDuration(blocked)})`;
  return `; server ${formatDuration(server)}${blockedPart} + client ${formatDuration(client)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
