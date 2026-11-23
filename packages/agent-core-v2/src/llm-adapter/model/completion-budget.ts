import type { LlmRequestModel } from '@moonshot-ai/core/llm/request';

export function resolveCompletionBudget(args: {
  readonly maxOutputSize?: number;
  readonly maxCompletionTokensCap?: number;
}): number | undefined {
  if (args.maxCompletionTokensCap !== undefined) {
    if (args.maxCompletionTokensCap <= 0) return undefined;
    return args.maxCompletionTokensCap;
  }
  if (args.maxOutputSize !== undefined && args.maxOutputSize > 0) {
    return args.maxOutputSize;
  }
  return undefined;
}


export function resolveMaxOutputTokens(args: {
  readonly maxOutputSize?: number;
  readonly maxCompletionTokensCap?: number;
}): LlmRequestModel['maxOutputTokens'] {
  if (args.maxCompletionTokensCap !== undefined && args.maxCompletionTokensCap <= 0) return 'none';
  const budget = resolveCompletionBudget(args);
  return budget === undefined ? undefined : Math.max(1, budget);
}
