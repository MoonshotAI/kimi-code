import type { ModelCapability } from '../contract/capability';

import type { CompletionBudgetParams } from './model.types';

const MIN_FLOOR = 1;

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

export function completionBudgetParams(args: {
  readonly budget: number | undefined;
  readonly capability: ModelCapability | undefined;
  readonly usedContextTokens?: number;
}): CompletionBudgetParams | undefined {
  if (args.budget === undefined) return undefined;
  return {
    maxCompletionTokens: Math.max(MIN_FLOOR, args.budget),
    usedContextTokens: args.usedContextTokens,
    maxContextTokens: args.capability?.max_context_tokens,
  };
}
