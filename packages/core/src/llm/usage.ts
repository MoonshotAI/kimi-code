/**
 * `TokenUsage` and its arithmetic: input and grand totals, addition, and merging the partial usage
 * reported during a stream.
 */

export interface TokenUsage {
  inputOther: number;
  output: number;
  inputCacheRead?: number;
  inputCacheCreation: number;
  raw?: Record<string, unknown>;
}

export function emptyUsage(): TokenUsage {
  return { inputOther: 0, output: 0, inputCacheCreation: 0 };
}

export function inputTotal(usage: TokenUsage): number | undefined {
  if (usage.inputCacheRead === undefined) return undefined;
  return usage.inputOther + usage.inputCacheRead + usage.inputCacheCreation;
}

export function grandTotal(usage: TokenUsage): number | undefined {
  const input = inputTotal(usage);
  return input === undefined ? undefined : input + usage.output;
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputOther: a.inputOther + b.inputOther,
    output: a.output + b.output,
    inputCacheRead:
      a.inputCacheRead === undefined || b.inputCacheRead === undefined
        ? undefined
        : a.inputCacheRead + b.inputCacheRead,
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
    inputCacheRead: patch.inputCacheRead ?? base?.inputCacheRead,
    inputCacheCreation: patch.inputCacheCreation ?? base?.inputCacheCreation ?? 0,
  };
}
