import type { ChatProvider, ModelCapability } from '@moonshot-ai/kosong';

/** Completion-token budget for the next LLM request. */
export interface CompletionBudgetConfig {
  /** Explicit user-configured maximum. */
  readonly hardCap?: number;
  /** Conservative cap for providers/models whose context window is unknown. */
  readonly fallback?: number;
}

const MIN_FLOOR = 1;
const DEFAULT_UNKNOWN_CONTEXT_FALLBACK = 32000;

/**
 * Resolve configured completion budget. Env values are explicit hard caps;
 * non-positive env values disable clamping.
 */
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

/**
 * Compute the effective `max_completion_tokens` cap.
 */
export function computeCompletionBudgetCap(args: {
  readonly budget: CompletionBudgetConfig;
  readonly capability: ModelCapability | undefined;
}): number {
  const maxCtx = args.capability?.max_context_tokens ?? 0;
  // The provider backend computes the safe request-specific value from the
  // serialized prompt. Locally using the largest cap avoids cutting off
  // thinking before the model produces a summary.
  const cap =
    args.budget.hardCap ??
    (maxCtx > 0 ? maxCtx : args.budget.fallback ?? DEFAULT_UNKNOWN_CONTEXT_FALLBACK);
  return Math.max(MIN_FLOOR, cap);
}

/**
 * Apply a completion budget to a provider via its optional
 * `withMaxCompletionTokens` capability. Returns the original provider
 * unchanged when no budget is configured or the provider opts out.
 *
 * The returned provider is intentionally a shallow clone that shares the
 * original's HTTP client. Callers MUST treat it as a single-step value
 * and NOT persist it back to durable agent state — see the F3 discussion
 * in `KimiChatProvider._clone()`.
 */
export function applyCompletionBudget(args: {
  readonly provider: ChatProvider;
  readonly budget: CompletionBudgetConfig | undefined;
  readonly capability: ModelCapability | undefined;
  readonly usedContextTokens?: number;
}): ChatProvider {
  if (args.budget === undefined) return args.provider;
  if (args.provider.withMaxCompletionTokens === undefined) return args.provider;
  const cap = computeCompletionBudgetCap({
    budget: args.budget,
    capability: args.capability,
  });
  return args.provider.withMaxCompletionTokens(cap, {
    usedContextTokens: args.usedContextTokens,
    maxContextTokens: args.capability?.max_context_tokens,
  });
}
