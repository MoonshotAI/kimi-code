import {
  type ChatProvider,
  type GenerationKwargs,
  KimiChatProvider,
  type ThinkingEffort,
} from '@moonshot-ai/kosong';

import { parseFloatEnv } from '#/config/resolve';

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Apply Kimi sampling params (`KIMI_MODEL_TEMPERATURE`, `KIMI_MODEL_TOP_P`) from
 * the environment to a chat provider. Applied at provider construction
 * (`ConfigState.provider`) so every request built from `config.provider` — the
 * main loop AND full-history compaction — carries them, matching kimi-cli where
 * these live on the shared `create_llm` provider. Applies globally to any Kimi
 * provider (not tied to `KIMI_MODEL_NAME`).
 *
 * Non-Kimi providers — and Kimi providers with neither var set — are returned
 * unchanged. `max_tokens` is intentionally NOT handled here: `KIMI_MODEL_MAX_TOKENS`
 * already flows through the completion-budget path (`resolveCompletionBudget`).
 */
export function applyKimiEnvSamplingParams(
  provider: ChatProvider,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider)) return provider;

  const kwargs: GenerationKwargs = {};
  const temperature = parseFloatEnv(env['KIMI_MODEL_TEMPERATURE'], 'KIMI_MODEL_TEMPERATURE');
  if (temperature !== undefined) kwargs.temperature = temperature;
  const topP = parseFloatEnv(env['KIMI_MODEL_TOP_P'], 'KIMI_MODEL_TOP_P');
  if (topP !== undefined) kwargs.top_p = topP;

  return Object.keys(kwargs).length > 0 ? provider.withGenerationKwargs(kwargs) : provider;
}

/**
 * Force a specific thinking effort via `KIMI_MODEL_THINKING_EFFORT`, bypassing
 * the model's declared `support_efforts`. Applied in `ConfigState.provider`
 * after `withThinking`, and only while thinking is on — effort has no meaning
 * when thinking is disabled. The value is forwarded verbatim as
 * `thinking.effort`, so callers can target a model that accepts an effort but
 * does not advertise one via `support_efforts`.
 *
 * Non-Kimi providers — and an unset/blank value — are returned unchanged.
 */
export function applyKimiEnvThinkingEffort(
  provider: ChatProvider,
  thinkingEffort: ThinkingEffort,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider)) return provider;
  const effort = env['KIMI_MODEL_THINKING_EFFORT']?.trim();
  if (effort === undefined || effort.length === 0 || thinkingEffort === 'off') return provider;
  return provider.withExtraBody({ thinking: { effort } });
}

/**
 * Apply the Moonshot preserved-thinking passthrough (`KIMI_MODEL_THINKING_KEEP`
 * -> `thinking.keep`) to a chat provider. Applied in `ConfigState.provider` after
 * `withThinking`, and only while thinking is on — otherwise the API would
 * receive a `thinking.keep` with no accompanying `thinking.type` it honors.
 * (Compaction uses a raw provider with thinking off, so it correctly skips this.)
 *
 * Non-Kimi providers — and an unset/blank value — are returned unchanged.
 */
export function applyKimiEnvThinkingKeep(
  provider: ChatProvider,
  thinkingEffort: ThinkingEffort,
  env: Env = process.env,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider)) return provider;
  const keep = env['KIMI_MODEL_THINKING_KEEP']?.trim();
  if (keep === undefined || keep.length === 0 || thinkingEffort === 'off') return provider;
  return provider.withExtraBody({ thinking: { keep } });
}
