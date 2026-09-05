import type { TokenUsage } from '#human/llm/usage';

export { emptyUsage } from '#human/llm/usage';
export type { TokenUsage } from '#human/llm/usage';

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
