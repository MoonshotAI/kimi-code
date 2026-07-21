/**
 * `kosong/model` domain (L2) — the completion-token budget, as pure functions.
 *
 * The budget no longer morphs a Model (there is no `applyCompletionBudget`):
 * the caller resolves a `CompletionBudgetConfig`, folds it into a per-turn cap
 * with `computeCompletionBudgetCap`, and passes the result through
 * `ModelRequestParams` (`maxCompletionTokens` + the window-clamp companions). The
 * wire base clamps the cap against the context window before any dialect
 * ceiling applies.
 *
 * Load-bearing rule: `usedContextTokens` is the caller's MEASURED in-context
 * tokens and is only folded in when the request did not explicitly override
 * its messages — with explicit messages the budget is not tightened against
 * the current context. `completionBudgetParams` is the single fold point that
 * keeps this honest.
 *
 * The `CompletionBudgetConfig` / `CompletionBudgetParams` types live in
 * `model.types.ts` with the domain's other shared data types.
 */

import type { ModelCapability } from '#/kosong/contract/capability';

import type { CompletionBudgetConfig, CompletionBudgetParams } from './model.types';

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

/**
 * Fold a resolved budget into the `ModelRequestParams` slice the requester sends.
 * `usedContextTokens` must be the measured in-context tokens, and must be
 * passed ONLY when the caller did not explicitly override the request
 * messages (see the module header); it is forwarded verbatim.
 */
export function completionBudgetParams(args: {
  readonly budget: CompletionBudgetConfig | undefined;
  readonly capability: ModelCapability | undefined;
  readonly usedContextTokens?: number;
}): CompletionBudgetParams | undefined {
  if (args.budget === undefined) return undefined;
  return {
    maxCompletionTokens: computeCompletionBudgetCap({
      budget: args.budget,
      capability: args.capability,
    }),
    usedContextTokens: args.usedContextTokens,
    maxContextTokens: args.capability?.max_context_tokens,
  };
}
