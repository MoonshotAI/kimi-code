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

