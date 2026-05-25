import type { TokenUsage } from '@moonshot-ai/kimi-code-sdk';

export function outputTokensPerSecond(
  usage: TokenUsage | undefined,
  startedAtMs: number,
  endedAtMs: number,
): number | null {
  const outputTokens = usage?.output;
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens) || outputTokens <= 0) {
    return null;
  }
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(endedAtMs)) return null;

  const elapsedMs = endedAtMs - startedAtMs;
  if (elapsedMs <= 0) return null;

  return outputTokens / (elapsedMs / 1000);
}
