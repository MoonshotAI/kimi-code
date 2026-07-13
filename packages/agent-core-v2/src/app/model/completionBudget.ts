/**
 * Completion-token budget — resolves env/config caps and applies them to a
 * runnable Model. Pure computation over the Model's `.withMaxCompletionTokens`
 * facade; no wire coupling.
 */

import type { ModelCapability } from '#/app/llmProtocol/capability';
import type { Model } from '#/app/model/modelInstance';

export interface CompletionBudgetConfig {
  readonly hardCap?: number;
  readonly fallback?: number;
}

const MIN_FLOOR = 1;
const DEFAULT_UNKNOWN_CONTEXT_FALLBACK = 32000;

export function resolveCompletionBudget(args: {
  readonly maxOutputSize?: number;
  readonly reservedContextSize?: number;
  readonly maxCompletionTokensCap?: number;
}): CompletionBudgetConfig | undefined {
  if (args.maxCompletionTokensCap !== undefined) {
    if (args.maxCompletionTokensCap <= 0) return undefined;
    return { hardCap: args.maxCompletionTokensCap };
  }
  if (args.maxOutputSize !== undefined && args.maxOutputSize > 0) {
    return { hardCap: args.maxOutputSize };
  }
  if (args.reservedContextSize !== undefined && args.reservedContextSize > 0) {
    return { fallback: args.reservedContextSize };
  }
  return { fallback: DEFAULT_UNKNOWN_CONTEXT_FALLBACK };
}

export function computeCompletionBudgetCap(args: {
  readonly budget: CompletionBudgetConfig;
  readonly capability: ModelCapability | undefined;
}): number {
  const maxCtx = args.capability?.max_context_tokens ?? 0;
  const cap =
    args.budget.hardCap ??
    (maxCtx > 0 ? maxCtx : args.budget.fallback ?? DEFAULT_UNKNOWN_CONTEXT_FALLBACK);
  return Math.max(MIN_FLOOR, cap);
}

export function applyCompletionBudget(args: {
  readonly model: Model;
  readonly budget: CompletionBudgetConfig | undefined;
  readonly capability: ModelCapability | undefined;
  readonly usedContextTokens?: number;
}): Model {
  if (args.budget === undefined) return args.model;
  const cap = computeCompletionBudgetCap({
    budget: args.budget,
    capability: args.capability,
  });
  return args.model.withMaxCompletionTokens(cap, {
    usedContextTokens: args.usedContextTokens,
    maxContextTokens: args.capability?.max_context_tokens,
  });
}
