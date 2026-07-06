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

const KEEP_OFF_VALUES = new Set(['0', 'false', 'no', 'off', 'none', 'null']);

type KeepResolution =
  | { readonly specified: false }
  | { readonly specified: true; readonly value: string | undefined };

/**
 * Parse a single keep source (env var or config field). A blank value is
 * "unspecified" and falls through to the next source; an off-value explicitly
 * disables Preserved Thinking (short-circuits, no fallback); anything else is
 * forwarded verbatim (e.g. "all").
 */
function parseKeepValue(raw: string | undefined): KeepResolution {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed.length === 0) return { specified: false };
  if (KEEP_OFF_VALUES.has(trimmed.toLowerCase())) return { specified: true, value: undefined };
  return { specified: true, value: trimmed };
}

/**
 * Resolve the Moonshot Preserved Thinking passthrough (`thinking.keep`) with
 * precedence env (`KIMI_MODEL_THINKING_KEEP`) > config (`thinking.keep`) >
 * default `"all"`. Only meaningful while thinking is on — otherwise the API
 * would receive a `thinking.keep` with no accompanying `thinking.type` it
 * honors. (Compaction uses a raw provider with thinking off, so it correctly
 * resolves to `undefined`.)
 *
 * Returns `undefined` when Preserved Thinking should be disabled.
 */
export function resolveThinkingKeep(
  env: Env,
  configKeep: string | undefined,
  thinkingEffort: ThinkingEffort,
): string | undefined {
  if (thinkingEffort === 'off') return undefined;
  const fromEnv = parseKeepValue(env['KIMI_MODEL_THINKING_KEEP']);
  if (fromEnv.specified) return fromEnv.value;
  const fromConfig = parseKeepValue(configKeep);
  if (fromConfig.specified) return fromConfig.value;
  return 'all';
}

/**
 * Apply the Moonshot Preserved Thinking passthrough to a chat provider. See
 * `resolveThinkingKeep` for precedence. Non-Kimi providers are returned
 * unchanged.
 */
export function applyKimiEnvThinkingKeep(
  provider: ChatProvider,
  thinkingEffort: ThinkingEffort,
  env: Env = process.env,
  configKeep?: string,
): ChatProvider {
  if (!(provider instanceof KimiChatProvider)) return provider;
  const keep = resolveThinkingKeep(env, configKeep, thinkingEffort);
  if (keep === undefined) return provider;
  return provider.withExtraBody({ thinking: { keep } });
}
