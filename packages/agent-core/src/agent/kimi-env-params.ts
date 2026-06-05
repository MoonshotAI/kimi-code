import {
  type ChatProvider,
  type GenerationKwargs,
  KimiChatProvider,
  type ThinkingEffort,
} from '@moonshot-ai/kosong';

import { parseFloatEnv } from '#/config/resolve';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Apply Kimi-specific request parameters from `KIMI_MODEL_*` environment
 * variables to a chat provider. Mirrors kimi-cli's `create_llm`: the params
 * apply to any Kimi provider (global — not tied to `KIMI_MODEL_NAME`), and
 * `thinking.keep` is attached only when thinking is on, otherwise the API would
 * receive a `thinking.keep` with no accompanying `thinking.type` it honors.
 *
 * Scope note: `max_tokens` is intentionally NOT handled here — `KIMI_MODEL_MAX_TOKENS`
 * (and `KIMI_MODEL_MAX_COMPLETION_TOKENS`) already flow through the completion-budget
 * path (`resolveCompletionBudget` -> `applyCompletionBudget`). Handling it here too
 * would be a redundant, conflicting second source.
 *
 * Non-Kimi providers — and Kimi providers with none of these env vars set — are
 * returned unchanged.
 */
export function applyKimiEnvGenerationParams(
  provider: ChatProvider,
  thinkingLevel: ThinkingEffort,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider)) return provider;

  const kwargs: GenerationKwargs = {};
  const temperature = parseFloatEnv(env['KIMI_MODEL_TEMPERATURE'], 'KIMI_MODEL_TEMPERATURE');
  if (temperature !== undefined) kwargs.temperature = temperature;
  const topP = parseFloatEnv(env['KIMI_MODEL_TOP_P'], 'KIMI_MODEL_TOP_P');
  if (topP !== undefined) kwargs.top_p = topP;

  let next: KimiChatProvider =
    Object.keys(kwargs).length > 0 ? provider.withGenerationKwargs(kwargs) : provider;

  const keep = env['KIMI_MODEL_THINKING_KEEP']?.trim();
  if (keep !== undefined && keep.length > 0 && thinkingLevel !== 'off') {
    next = next.withExtraBody({ thinking: { keep } });
  }

  return next;
}
