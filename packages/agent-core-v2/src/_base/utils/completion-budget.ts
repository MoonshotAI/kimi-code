/**
 * Completion-token budget — resolves env/config caps and applies them to a
 * chat provider.
 */

import type { ChatProvider, ModelCapability } from '@moonshot-ai/kosong';

export interface CompletionBudgetConfig {
  readonly hardCap?: number;
  readonly fallback?: number;
}

const MIN_FLOOR = 1;
const DEFAULT_UNKNOWN_CONTEXT_FALLBACK = 32000;

export function resolveCompletionBudget(args: {
  readonly maxOutputSize?: number;
  readonly reservedContextSize?: number;
  readonly env?: NodeJS.ProcessEnv;
}): CompletionBudgetConfig | undefined {
  const env = args.env ?? process.env;
  const fromNew = parseEnvBudget(env['KIMI_MODEL_MAX_COMPLETION_TOKENS']);
  if (fromNew !== 'absent') {
    return fromNew === 'disabled' ? undefined : { hardCap: fromNew };
  }
  const fromLegacy = parseEnvBudget(env['KIMI_MODEL_MAX_TOKENS']);
  if (fromLegacy !== 'absent') {
    return fromLegacy === 'disabled' ? undefined : { hardCap: fromLegacy };
  }
  if (args.maxOutputSize !== undefined && args.maxOutputSize > 0) {
    return { hardCap: args.maxOutputSize };
  }
  if (args.reservedContextSize !== undefined && args.reservedContextSize > 0) {
    return { fallback: args.reservedContextSize };
  }
  return { fallback: DEFAULT_UNKNOWN_CONTEXT_FALLBACK };
}

type EnvBudget = number | 'disabled' | 'absent';

function parseEnvBudget(raw: string | undefined): EnvBudget {
  if (raw === undefined || raw === '') return 'absent';
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'absent';
  if (n <= 0) return 'disabled';
  return n;
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
  readonly provider: ChatProvider;
  readonly budget: CompletionBudgetConfig | undefined;
  readonly capability: ModelCapability | undefined;
}): ChatProvider {
  if (args.budget === undefined) return args.provider;
  if (args.provider.withMaxCompletionTokens === undefined) return args.provider;
  const cap = computeCompletionBudgetCap({
    budget: args.budget,
    capability: args.capability,
  });
  return args.provider.withMaxCompletionTokens(cap);
}
